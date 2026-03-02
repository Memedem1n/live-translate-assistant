# Windows Code Signing Kurulumu (TR)

Bu dokuman, GitHub Actions uzerinde Windows installer'i imzalamak icin gereken secret kurulumunu aciklar.

## Gerekli Secret'lar

Repo ayarlarina su iki secret eklenmelidir:

- `WINDOWS_CERT_PFX_BASE64`
- `WINDOWS_CERT_PASSWORD`

## 1) PFX dosyasini Base64'e cevir

PowerShell:

```powershell
$bytes = [System.IO.File]::ReadAllBytes("C:\cert\codesign.pfx")
[System.Convert]::ToBase64String($bytes) | Set-Clipboard
```

Panoya kopyalanan degeri `WINDOWS_CERT_PFX_BASE64` secret'ina yapistir.

## 2) PFX sifresini secret olarak ekle

- `WINDOWS_CERT_PASSWORD` degeri: PFX export sifresi.

## Alternatif: Secret'lari otomatik yukle (onerilen)

Proje icindeki script ile iki secret tek adimda yuklenebilir:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/set_codesign_secrets.ps1 -PfxPath "C:\cert\codesign.pfx"
```

Opsiyonel parametreler:

- `-Repo "owner/repo"`: hedef repo (verilmezse mevcut `gh repo` kullanilir)
- `-Password "..."`: prompt yerine sifreyi parametre ile verir

Readiness kontrolu:

```powershell
npm run codesign:check
```

## 3) Workflow davranisi

- Tag release (`refs/tags/v*`) ve `workflow_dispatch` calismalarinda signing opsiyoneldir.
- Secret'lar yoksa workflow unsigned installer uretir.
- Signing aciksa workflow:
  - PFX'i runner'a yazar
  - `CSC_LINK` ve `CSC_KEY_PASSWORD` env degiskenlerini ayarlar
  - Uretilen `.exe` dosyalarda `Get-AuthenticodeSignature` ile `Valid` kontrolu yapar
