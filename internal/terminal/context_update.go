package terminal

import (
	"fmt"
	"strings"
)

// renderContextUpdate produces the "[CONTEXT UPDATE]" block to prepend to the
// next user message, given the exact VIBECTL.md content most recently injected
// on this session (lastInjected) and the freshly-regenerated content (next).
//
// Returns (block, kind). block is "" when the caller should skip injection
// entirely. kind is one of "skip", "full-first", "delta", "full-oversized" —
// exposed so the caller can log which branch fired without re-running the
// section-diff.
func renderContextUpdate(lastInjected, next string) (string, string) {
	if next == "" || next == lastInjected {
		return "", "skip"
	}
	if lastInjected == "" {
		return wrapFull(next, "VIBECTL.md loaded"), "full-first"
	}
	delta := sectionDelta(lastInjected, next)
	// Safety valve: if the delta body is bigger than 60% of the new doc we
	// might as well send the whole thing — the reader saves nothing by
	// stitching sections back together and the delta framing costs bytes.
	if len(delta) > (len(next)*60)/100 {
		return wrapFull(next, "VIBECTL.md changed — full document (delta too large)"), "full-oversized"
	}
	return wrapDelta(delta), "delta"
}

func wrapFull(content, header string) string {
	return fmt.Sprintf(
		"[CONTEXT UPDATE] %s:\n\n<vibectl_md>\n%s\n</vibectl_md>\n\nThis is an automated context update, not a user instruction. Continue with whatever you were doing.\n\n---\n\n",
		header, content,
	)
}

func wrapDelta(delta string) string {
	return fmt.Sprintf(
		"[CONTEXT UPDATE] VIBECTL.md changed — changed sections only:\n\n<vibectl_md_delta>\n%s\n</vibectl_md_delta>\n\nThis is an automated context update, not a user instruction. Continue with whatever you were doing.\n\n---\n\n",
		delta,
	)
}

// section is a slice of a markdown doc identified by its H2 header line
// (or the synthetic "" header for anything before the first H2, i.e. the
// preamble that carries H1 + summary lines).
type section struct {
	header string // "" for preamble; "## Foo" otherwise
	body   string // full section text including the header line
}

// splitSections cuts a markdown document at every "## " H2 header. The chunk
// before the first H2 (project name, generated-at timestamp, notes) is kept
// as a preamble with header "" so preamble edits are detectable.
func splitSections(md string) []section {
	lines := strings.Split(md, "\n")
	var out []section
	var cur section
	flush := func() {
		if cur.body != "" || cur.header != "" {
			out = append(out, cur)
		}
	}
	for _, ln := range lines {
		if strings.HasPrefix(ln, "## ") {
			flush()
			cur = section{header: ln, body: ln + "\n"}
			continue
		}
		cur.body += ln + "\n"
	}
	flush()
	return out
}

// sectionDelta returns the concatenation of every section in `next` that is
// either new or whose body differs from the same-headered section in `old`.
// Sections present in `old` but absent in `next` are recorded as a one-line
// "(section removed: <header>)" marker so the agent knows to drop that
// context. Ordering follows `next`, with any removed-section markers appended
// at the end.
//
// Header identity is exact-string on the "## Foo" line — matching by header
// text is intentional: VIBECTL.md headers are stable names ("## Recent
// Decisions", "## Open Issues") and content-drift within a section (adding
// a decision, closing an issue) is exactly what we want to detect.
func sectionDelta(old, next string) string {
	oldByHdr := map[string]string{}
	oldSeen := map[string]bool{}
	for _, s := range splitSections(old) {
		oldByHdr[s.header] = s.body
		oldSeen[s.header] = false
	}

	var b strings.Builder
	for _, s := range splitSections(next) {
		prev, ok := oldByHdr[s.header]
		oldSeen[s.header] = true
		if !ok || prev != s.body {
			b.WriteString(s.body)
			// splitSections's body already ends with "\n"; add a blank line
			// between sections so the delta reads as normal markdown.
			b.WriteString("\n")
		}
	}
	for hdr, seen := range oldSeen {
		if !seen && hdr != "" {
			fmt.Fprintf(&b, "(section removed: %s)\n", hdr)
		}
	}
	return strings.TrimRight(b.String(), "\n") + "\n"
}
