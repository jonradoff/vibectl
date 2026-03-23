#!/bin/sh
# Fix ownership of the /data volume (mounted as root) so vibectl user can write to it
chown -R vibectl:vibectl /data 2>/dev/null || true

# Persist Claude Code auth across deploys: symlink ~/.claude → /data/.claude
# so OAuth tokens survive container rebuilds
mkdir -p /data/.claude
chown -R vibectl:vibectl /data/.claude 2>/dev/null || true
# Remove any stale dir/symlink and create fresh symlink
rm -rf /home/vibectl/.claude 2>/dev/null || true
ln -s /data/.claude /home/vibectl/.claude

# Also persist ~/.claude.json (Claude Code config file) on the volume
if [ -f /data/.claude.json ]; then
  ln -sf /data/.claude.json /home/vibectl/.claude.json
elif [ -f /home/vibectl/.claude.json ]; then
  cp /home/vibectl/.claude.json /data/.claude.json
  ln -sf /data/.claude.json /home/vibectl/.claude.json
fi

# Restore .claude.json from backup if missing
if [ ! -f /data/.claude.json ]; then
  BACKUP=$(ls -t /data/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1)
  if [ -n "$BACKUP" ]; then
    cp "$BACKUP" /data/.claude.json
    ln -sf /data/.claude.json /home/vibectl/.claude.json
  fi
fi

# Drop to non-root user and exec the server
exec su-exec vibectl /app/vibectl-server "$@"
