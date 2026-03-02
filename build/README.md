# Build Assets

- `icon.ico`: Windows app icon used by electron-builder.

Generate/update icon with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate_icon.ps1 -OutputPath build/icon.ico
```

Replace `build/icon.ico` with your brand icon before production release if needed.
