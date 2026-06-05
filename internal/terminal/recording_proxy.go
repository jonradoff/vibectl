package terminal

import (
	"bufio"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// recordingProxy is a per-Claude-Code-spawn sidecar that captures Anthropic API
// traces in cache-optimizer corpus format. Off by default; enabled via
// VIBECTL_RECORD_TRACES=1. Lifecycle is bound to a single ChatSession.
type recordingProxy struct {
	cmd     *exec.Cmd
	port    int
	once    sync.Once
	stopped chan struct{}
}

// stop sends SIGTERM and waits briefly for the proxy to flush its trace file
// and exit. Idempotent.
func (p *recordingProxy) stop() {
	if p == nil {
		return
	}
	p.once.Do(func() {
		defer close(p.stopped)
		if p.cmd == nil || p.cmd.Process == nil {
			return
		}
		if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
			// Process likely already exited.
			return
		}
		done := make(chan error, 1)
		go func() { done <- p.cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			slog.Warn("recording proxy did not exit on SIGTERM, killing", "port", p.port)
			_ = p.cmd.Process.Kill()
			<-done
		}
	})
}

// startRecordingProxy spawns the recording proxy for a single Claude Code session.
//
// Behavior is non-fatal: if any step fails, returns (nil, error) and the caller
// proceeds without recording. This is a research-only feature and must never
// block a real Claude Code session.
func startRecordingProxy(proxyCmd, proxyDir, outputDir, sessionID string) (*recordingProxy, error) {
	if proxyCmd == "" {
		return nil, fmt.Errorf("recording proxy command not configured")
	}

	port, err := allocEphemeralPort()
	if err != nil {
		return nil, fmt.Errorf("alloc port: %w", err)
	}

	parts := strings.Fields(proxyCmd)
	if len(parts) == 0 {
		return nil, fmt.Errorf("empty recording proxy command")
	}
	args := append(parts[1:],
		"--port", fmt.Sprintf("%d", port),
		"--session-id", sessionID,
		"--output-dir", outputDir,
	)
	cmd := exec.Command(parts[0], args...)
	if proxyDir != "" {
		cmd.Dir = proxyDir
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	cmd.Stderr = newProxyLogWriter(port)

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start proxy: %w", err)
	}

	if err := waitForReady(stdout, port, 5*time.Second); err != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		go cmd.Wait()
		return nil, fmt.Errorf("proxy ready wait: %w", err)
	}

	// Keep draining stdout so the proxy doesn't block on a full pipe.
	go io.Copy(io.Discard, stdout)

	slog.Info("recording proxy started", "port", port, "sessionID", sessionID, "outputDir", outputDir)
	return &recordingProxy{cmd: cmd, port: port, stopped: make(chan struct{})}, nil
}

// allocEphemeralPort asks the kernel for a free port on 127.0.0.1, closes the
// listener, and returns the port. There's a small TOCTOU window between close
// and the proxy bind, but it's benign for a single-user local sidecar.
func allocEphemeralPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port, nil
}

func waitForReady(r io.Reader, port int, timeout time.Duration) error {
	want := fmt.Sprintf("ready on :%d", port)
	done := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(r)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), want) {
				done <- nil
				return
			}
		}
		done <- fmt.Errorf("proxy stdout closed before ready signal")
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		return fmt.Errorf("timeout waiting for ready on :%d", port)
	}
}

// newProxyLogWriter forwards each line of proxy stderr to slog at warn level.
func newProxyLogWriter(port int) io.Writer {
	pr, pw := io.Pipe()
	go func() {
		scanner := bufio.NewScanner(pr)
		for scanner.Scan() {
			slog.Warn("recording proxy stderr", "port", port, "line", scanner.Text())
		}
	}()
	return pw
}
