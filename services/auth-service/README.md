# Auth Service

Port: 5001

- Built with Node.js and Express
- Uses PostgreSQL (via Prisma) for user authentication data
- Handles user authentication, JWT token generation, OTP-based login, and session management
- Dependencies: express, jsonwebtoken, prisma

## Setup

1. Install dependencies:
```bash
cd services/auth-service && npm install
```

2. Set up environment variables:
Create `.env` file with:
```
AUTH_SERVICE_PORT=5001
DATABASE_URL="postgresql://user:password@localhost:5432/auth_db"
JWT_SECRET="your-jwt-secret"
```

3. Start the service:
```bash
npm run dev
```

## API Endpoints

- `POST /api/auth/signup` - User registration
- `POST /api/auth/login` - User login (OTP-based)
- `POST /api/auth/refresh-token` - Refresh JWT token
- `POST /api/auth/logout` - Logout and revoke tokens
- `POST /api/auth/send-otp` - Request OTP for login
- `POST /api/auth/verify-otp` - Verify OTP and login
- `GET /api/auth/app-config` - Public app configuration
- `GET /api/auth/otp-config` - OTP provider configuration
- `GET /health` - Health check