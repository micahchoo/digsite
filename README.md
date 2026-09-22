# digsite

A shared, sortable image board with hand-arranged sheets on top.

See `CONTEXT.md` for vocabulary and `docs/design.md` for the full contract.

## Run

```
cp .env.example .env
bun install
bun run db:up
bun run db:migrate
bun run seed
bun run dev
```
