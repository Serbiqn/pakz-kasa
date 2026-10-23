# Pakz Kasa

Privatni sajt za beleženje zarade Pakz programa (Dušan & Pavle).

- Login za Dušana i Pavla (odvojene šifre)
- Uplate i troškovi u evrima ili dinarima — sve se prikazuje u oba
- Svaka stavka zaključava NBS srednji kurs na svoj datum
- Podela pola-pola: zarada i zajednički troškovi se dele, lični troškovi se skidaju samo jednom
- Svaka izmena se beleži u „Promene" (ko, kada, šta), obrisano se može vratiti
- Backup u JSON fajl i vraćanje iz njega

## Netlify podešavanje

Site configuration → Environment variables:

| Promenljiva | Vrednost |
|---|---|
| `DUSAN_PASSWORD` | Dušanova šifra |
| `PAVLE_PASSWORD` | Pavlova šifra |
| `SESSION_SECRET` | dugačak nasumičan tekst |
| `DISCORD_WEBHOOK_URL` | (opciono) webhook Discord kanala — svaka uplata, trošak, izmena i brisanje se šalje u kanal |

Podaci se čuvaju u Netlify Blobs (store `pakz-kasa`). Build komanda nije potrebna, publish folder je `public`.
