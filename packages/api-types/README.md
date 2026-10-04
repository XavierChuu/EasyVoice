# packages/api-types

TypeScript types **sinh tự động** từ OpenAPI của engine — không sửa tay.

- `openapi.json`: `cd engine && python -m easyvoice_engine.openapi > ../packages/api-types/openapi.json`
- `src/schema.d.ts`: `cd apps/desktop && npm run gen:api`

App dùng qua `apps/desktop/src/api/types.ts`.
