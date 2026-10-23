# Pakz Kasa

Privatni sajt za beleženje zarade Pakz programa (Dušan & Pavle).

- Login za Dušana i Pavla (odvojene šifre)
- Uplate i troškovi u evrima ili dinarima — sve se prikazuje u oba
- Svaka stavka zaključava NBS srednji kurs na svoj datum
- Podela pola-pola: zarada i zajednički troškovi se dele, lični troškovi se skidaju samo jednom
- Svaka izmena se beleži u „Promene" (ko, kada, šta), obrisano se može vratiti
- Backup u JSON fajl i vraćanje iz njega

## Podešavanje

Ništa ne treba podešavati na Netlify-u:
- pri prvom otvaranju sajt traži da se postave šifre za Dušana i Pavla
- tajni ključ za login sajt pravi sam
- Discord webhook se lepi u meniju sajta (avatar → Discord kanal)

Sve se čuva u Netlify Blobs (store `pakz-kasa`). Opciono, env promenljive `DUSAN_PASSWORD`, `PAVLE_PASSWORD`, `SESSION_SECRET` i `DISCORD_WEBHOOK_URL` imaju prednost ako postoje.
