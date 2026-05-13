# MCP VPS Setup - Starken OS

This project can be exposed to MCP clients through SSH, but the real source of truth remains the VPS folder:

`/var/www/starken-os`

## Safe Rule

Do not commit real MCP config files with credentials or tokens. Keep local/private MCP config in `.mcp.json`, `.mcp.local.json`, or your Codex/IDE user settings.

## Example MCP Server Over SSH

Use this as a starting point in your local/private MCP config. It assumes SSH key access to the VPS and Node/npm available on the VPS.

```json
{
  "mcpServers": {
    "starken-os-vps-files": {
      "command": "ssh",
      "args": [
        "root@187.77.46.199",
        "cd /var/www/starken-os && npx -y @modelcontextprotocol/server-filesystem /var/www/starken-os"
      ]
    }
  }
}
```

## Notes

- Prefer SSH keys instead of passwords.
- Keep `.mcp.json` untracked.
- Before editing through any MCP filesystem server, run the same VPS workflow from `AGENTS.md`: check `git status`, create backup/checkpoint, edit surgically, validate, then checkpoint.
- If the MCP server package is not installed/available on the VPS, install or run it only after confirming Node/npm are configured there.
