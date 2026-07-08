package terminal

import (
	"strings"
	"testing"
)

// A representative VIBECTL.md-shaped doc: preamble, then a few H2 sections.
const baseDoc = `# LOOM

Generated: 2026-07-07T21:00:00Z

## Recent Decisions

- 2026-07-05: adopt Bun
- 2026-07-03: drop Yarn

## Open Issues

- LOOM-14: intent dedup
- LOOM-15: reset button

## Deployment

fly.io — app "loom"
`

func TestFirstInjectionIsFull(t *testing.T) {
	block, kind := renderContextUpdate("", baseDoc)
	if kind != "full-first" {
		t.Fatalf("kind = %q, want full-first", kind)
	}
	if !strings.Contains(block, "<vibectl_md>") || !strings.Contains(block, "</vibectl_md>") {
		t.Fatalf("full-first block should carry <vibectl_md> wrapper; got %q", block)
	}
	if !strings.Contains(block, "LOOM-14") {
		t.Fatalf("full-first block should carry the doc content")
	}
	if !strings.Contains(block, "not a user instruction") {
		t.Fatalf("full-first block should preserve the framing sentence")
	}
}

func TestIdenticalContentSkipped(t *testing.T) {
	block, kind := renderContextUpdate(baseDoc, baseDoc)
	if kind != "skip" || block != "" {
		t.Fatalf("identical content should skip; got (kind=%q, block=%q)", kind, block)
	}
}

func TestEmptyNextSkipped(t *testing.T) {
	block, kind := renderContextUpdate(baseDoc, "")
	if kind != "skip" || block != "" {
		t.Fatalf("empty next should skip; got (kind=%q, block=%q)", kind, block)
	}
}

func TestSmallEditSendsOnlyChangedSection(t *testing.T) {
	next := strings.Replace(baseDoc,
		"- LOOM-14: intent dedup",
		"- LOOM-14: intent dedup (closed)",
		1)
	block, kind := renderContextUpdate(baseDoc, next)
	if kind != "delta" {
		t.Fatalf("small edit should produce a delta; got kind=%q", kind)
	}
	if !strings.Contains(block, "<vibectl_md_delta>") {
		t.Fatalf("delta block should use <vibectl_md_delta> wrapper; got %q", block)
	}
	if !strings.Contains(block, "## Open Issues") {
		t.Fatalf("delta should include the changed section header 'Open Issues'")
	}
	if !strings.Contains(block, "LOOM-14: intent dedup (closed)") {
		t.Fatalf("delta should include the new body of the changed section")
	}
	// Unchanged sections must NOT appear in the delta.
	if strings.Contains(block, "## Recent Decisions") {
		t.Fatalf("delta must not include unchanged 'Recent Decisions' section; block=%q", block)
	}
	if strings.Contains(block, "## Deployment") {
		t.Fatalf("delta must not include unchanged 'Deployment' section; block=%q", block)
	}
}

func TestLargeEditFallsBackToFull(t *testing.T) {
	// Rewrite every section — the delta will contain essentially the whole
	// doc, and the 60% safety valve should kick in.
	next := `# LOOM

Generated: 2026-07-07T22:00:00Z

## Recent Decisions

- 2026-07-07: adopt Rust
- 2026-07-06: drop TypeScript
- 2026-07-05: split monorepo

## Open Issues

- LOOM-30: rewrite server
- LOOM-31: rewrite client
- LOOM-32: rewrite tests

## Deployment

k8s — cluster "loom-prod"
Region: us-east-1
`
	block, kind := renderContextUpdate(baseDoc, next)
	if kind != "full-oversized" {
		t.Fatalf("large edit should hit safety valve; got kind=%q", kind)
	}
	if !strings.Contains(block, "<vibectl_md>") {
		t.Fatalf("full-oversized block should use full-doc wrapper; got %q", block)
	}
	if !strings.Contains(block, "delta too large") {
		t.Fatalf("full-oversized block should mention delta too large in the header")
	}
}

func TestSectionAddedIsIncluded(t *testing.T) {
	next := baseDoc + `
## New Runbook

- how to roll back a bad deploy
`
	block, kind := renderContextUpdate(baseDoc, next)
	if kind != "delta" {
		t.Fatalf("adding one section should be a delta; got kind=%q", kind)
	}
	if !strings.Contains(block, "## New Runbook") {
		t.Fatalf("delta should include the newly-added section")
	}
	if strings.Contains(block, "## Recent Decisions") {
		t.Fatalf("delta should not include unchanged sections; got %q", block)
	}
}

func TestSectionRemovedIsNoted(t *testing.T) {
	// Remove "## Deployment" entirely.
	next := `# LOOM

Generated: 2026-07-07T21:00:00Z

## Recent Decisions

- 2026-07-05: adopt Bun
- 2026-07-03: drop Yarn

## Open Issues

- LOOM-14: intent dedup
- LOOM-15: reset button
`
	block, kind := renderContextUpdate(baseDoc, next)
	if kind != "delta" {
		t.Fatalf("removed section alone should still be a delta; got kind=%q", kind)
	}
	if !strings.Contains(block, "(section removed: ## Deployment)") {
		t.Fatalf("delta should include the removal marker; got %q", block)
	}
}

func TestPreambleChangeDetected(t *testing.T) {
	// Only the Generated timestamp changes (preamble edit, all H2 bodies
	// identical). We want that shipped as a delta.
	next := strings.Replace(baseDoc,
		"Generated: 2026-07-07T21:00:00Z",
		"Generated: 2026-07-07T23:59:59Z",
		1)
	block, kind := renderContextUpdate(baseDoc, next)
	if kind != "delta" {
		t.Fatalf("preamble edit should produce a delta; got kind=%q", kind)
	}
	if !strings.Contains(block, "Generated: 2026-07-07T23:59:59Z") {
		t.Fatalf("delta should include the new preamble content")
	}
	if strings.Contains(block, "## Recent Decisions") {
		t.Fatalf("preamble-only edit should not include unchanged H2 sections; got %q", block)
	}
}
