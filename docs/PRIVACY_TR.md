# Gizlilik ve Veri Politikasi (TR)

## Temel Ilke
Uygulama varsayilan olarak local-first calisir. Ses, transkript ve cevap uretimi cihaz uzerinde islenir.

## Kayit Politikasi
- Varsayilan: gecmis kalici olarak saklanmaz.
- Opt-in acildiginda: gecmis yerel olarak saklanir.
- Hassas ayarlar (uygun oldugunda): `safeStorage` ile sifrelenir.

## Ag Erisimi
- V1 ana akis: local Ollama endpoint (`127.0.0.1`).
- Harici servis baglantisi varsayilan olarak yoktur.

## Kullanici Kontrolleri
- Overlay gorunurluk kontrolu
- Click-through modu
- Suggestion mute
- Session start/stop

## Sinirlar
- Ekran koruma davranisi, farkli ekran paylasim uygulamalarinda ayni sonucu garanti etmez.
- Cihaz seviyesinde malware/uzaktan erisim gibi riskler uygulama kapsam disidir.
