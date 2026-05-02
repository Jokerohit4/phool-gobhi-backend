# Phool Gobhi Backend - Polyglot Architecture

This backend is built using a polyglot architecture, where different services use different technologies and databases based on their specific needs.

## Services

### Auth Service (Port: 5001)
- Built with Node.js and Express
- Uses PostgreSQL (via Prisma) for user authentication data
- Handles user authentication, JWT token generation, and session management
- Dependencies: express, jsonwebtoken, bcrypt, prisma

### User Service (Port: 5002)
- Built with Node.js and Express
- Uses MongoDB for user profile and related data
- Handles user profile management, preferences, and user-related operations
- Dependencies: express, mongoose

## Setup

1. Install dependencies for each service:
```bash
cd services/auth-service && npm install
cd services/user-service && npm install
```

2. Set up environment variables:
Create `.env` files in each service directory with the following variables:

Auth Service (.env):
```
AUTH_SERVICE_PORT=5001
DATABASE_URL="postgresql://user:password@localhost:5432/auth_db"
JWT_SECRET="your-jwt-secret"
```

User Service (.env):
```
USER_SERVICE_PORT=5002
MONGODB_URI="mongodb://localhost:27017/user_db"
```

3. Start the services:
```bash
# Start Auth Service
cd services/auth-service && npm run dev

# Start User Service
cd services/user-service && npm run dev
```

## API Endpoints

### Auth Service (http://localhost:5001)
- POST /api/auth/register
- POST /api/auth/login
- POST /api/auth/logout
- GET /health

### User Service (http://localhost:5002)
- GET /api/users/profile
- PUT /api/users/profile
- GET /health 