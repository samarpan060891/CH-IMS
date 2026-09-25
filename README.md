# Citi Homes IMS — Raw Material Inventory & Shop-floor Issuance

Cloud inventory system for **Citi Homes Kitchen and Wooden Furniture Manufacturing LLC** (UAE).

**Live app:** https://ch-ims-production.up.railway.app

| Layer | Where |
|---|---|
| Database, logins, business rules | Supabase project `vvkkvudwbolhuveuxorc` (Mumbai) |
| Web app (static HTML/JS, no build step) | `web/` — served by Caddy on Railway |
| Admin user function | `supabase/functions/admin-users` |

## Modules
- **Masters**: items (class, category, UoM, specs, TOC buffer, MOQ, re-order, lead time), vendors (TRN, trade licence, payment terms, bank), locations (warehouse → zone → rack → bin), projects & make-to-stock orders, employees, cost centres, payment terms, vendor price list.
- **Purchase**: requisitions → purchase orders (Factory Manager → Finance → top-management reference) → release; replenishment suggestions from TOC buffers / re-order levels.
- **Stores**: GRN against PO or non-PO / opening / customer-supplied / samples, landed cost (freight, customs, clearing), lots & batches, expiry; FIFO/FEFO issues to projects, MTS orders or cost centres; returns from floor; transfers; physical count adjustments (FM approval); purchase returns.
- **Shop floor**: material requests approved by the Production In-charge.
- **Tool crib & assets**: machines, power/hand/measuring tools, office and labour-accommodation equipment get an asset tag per unit; issue/return to workers, overdue tracking, calibration.
- **Scrap**: scrap generation and write-off (FM approval), scrap-yard stock, disposal / sale with gate pass (Factory Manager → Finance confirms rates & receipt).
- **Project vs stock purchasing**: every requisition / PO / GRN line is either for general stock or for a named project. Project lines create stock **reserved** for that project (only its issues can use it; own stock is issued first). Leftovers go back to general stock through an FM-approved **Project stock release**. Buffers and re-order suggestions use free stock and stock POs only.
- **Excel import**: templates for Items, Vendors and Opening stock (opening stock becomes a draft GRN for Stores to post); rows are validated before import.
- **Notifications**: in-app bell; every approval step notifies the next approver's role and informs the requester of approvals/rejections.
- **Finance**: vendor invoices (3-way match), payment vouchers (bank, cheque, PDC, cash, LC, advances), debit notes, net payables with aging.
- **Reports**: stock in hand, by lot/location, stock-out, overstock & non-moving, TOC buffer status, aging, ABC, valuation by category, project consumption, expiry, payables, open invoices, GRN-not-invoiced, tools with workers, calibration, stock ledger.
- **PDFs**: PO, GRN, material request, **issue slip**, return notes, transfer, count sheet, scrap note, disposal gate pass, debit note, payment voucher.

## Valuation
Per item class: Raw materials **FIFO**; consumables, packing, spares, scrap **weighted average**; machines/tools/equipment **fixed assets at landed cost**. An item may override FIFO/WAVG until it has transactions.

## Roles
Administrator, Purchase, Stores, Shop Floor, Production In-charge, Factory Manager, Finance Manager. Shop Floor and Production In-charge do not see costs.

## Desktop icon (any staff PC)
```
powershell -ExecutionPolicy Bypass -File tools/create-shortcut.ps1
```
Creates a **Citi Homes IMS** icon on the desktop that opens the live app in its own window (Edge app mode, Chrome as fallback).

## Run locally
```
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```
Open http://localhost:8080

## Deploy (Railway)
Railway builds the `Dockerfile` (Caddy serving `web/`). Connect the GitHub repo in Railway → *New Project → Deploy from GitHub repo*, then *Settings → Networking → Generate Domain*. Add that domain to Supabase → Authentication → URL Configuration (Site URL + Redirect URLs).

## Database migrations
`supabase/migrations/001…007` — already applied to the Supabase project, kept here as the source of truth.
