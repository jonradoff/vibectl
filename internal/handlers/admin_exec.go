//go:build !windows

package handlers

import (
	"os"
	"syscall"
)

// execSelf replaces the current process with the new binary at the given path.
// We pass only the binary name as argv[0] since the server reads config from env.
func execSelf(binary string) error {
	return syscall.Exec(binary, []string{binary}, os.Environ())
}
