# Database Setup Guide for Auth Service

## How to Create/Ensure the User Table Exists

### Method 1: Using Prisma Migrations (Recommended for Production)

1. **Check migration status:**
   ```bash
   cd services/auth-service
   npx prisma migrate status
   ```

2. **Apply pending migrations:**
   ```bash
   npx prisma migrate deploy
   ```

3. **If migrations are out of sync, resolve conflicts:**
   ```bash
   # Mark a failed migration as rolled back
   npx prisma migrate resolve --rolled-back <migration_name>
   
   # Then apply again
   npx prisma migrate deploy
   ```

### Method 2: Using Prisma DB Push (Quick for Development)

```bash
cd services/auth-service
npx prisma db push
```

This will sync your Prisma schema with the database without creating migration files. **Use with caution in production!**

### Method 3: Create a New Migration

1. **Create a new migration:**
   ```bash
   npx prisma migrate dev --name create_user_table
   ```

2. **Apply it:**
   ```bash
   npx prisma migrate deploy
   ```

### Verify the Table Exists

1. **Check via API:**
   ```bash
   curl http://localhost:5001/debug/db-test
   ```

2. **Check via Prisma:**
   ```bash
   npx prisma studio
   ```

3. **Check via SQL:**
   ```bash
   # Using Prisma's db execute
   npx prisma db execute --stdin <<< "SELECT * FROM \"User\" LIMIT 1;"
   ```

## Common Issues and Solutions

### Issue: "Table does not exist" (P2021)

**Solution:**
1. Apply migrations: `npx prisma migrate deploy`
2. Or use db push: `npx prisma db push`

### Issue: "Enum values don't match"

**Solution:**
1. Check enum values in database vs schema
2. Fix enum if needed (may require dropping and recreating)
3. Regenerate Prisma client: `npx prisma generate`

### Issue: "updatedAt is missing"

**Solution:**
- The schema has `@updatedAt` which should auto-handle this
- If issues persist, explicitly set `updatedAt: new Date()` in create calls
- Or ensure the database column has a default: `ALTER TABLE "User" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;`

### Issue: Migration conflicts

**Solution:**
1. Check what migrations are applied: `npx prisma migrate status`
2. Resolve conflicts: `npx prisma migrate resolve --applied <migration_name>`
3. Or reset (⚠️ deletes all data): `npx prisma migrate reset`

## Current Schema

The User table should have:
- `id` (Int, primary key, auto-increment)
- `name` (String, required)
- `email` (String, unique, required)
- `password` (String, required)
- `role` (Role enum: customer, partner, gobhi)
- `type` (UserType enum: general, sub_premium, premium)
- `gobhiType` (GobhiType enum: trainer, cleaner, manager, nullable)
- `createdAt` (DateTime, auto-set)
- `updatedAt` (DateTime, auto-updated)

## Regenerate Prisma Client

After any schema changes:
```bash
npx prisma generate
```

Then restart your service to pick up the new client.

