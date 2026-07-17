# Services

- `auth-service/`: Authentication, OTP, user/profile management, staff (gobhi) accounts.
- `wallet-service/`: Wallet balance, Razorpay top-up orders/webhook, credit/debit.
- `gym-service/`: Gym CRUD, images/docs (Cloudinary), reviews, slot availability.
- `booking-service/`: Booking lifecycle, check-in, FCM push notifications.
- `buddy-service/`: Gym-buddy matchmaking (discovery, swipes, matches, chat).

`user-service/` (MongoDB) and `payment-wallet-service/` (Java Spring Boot) no
longer exist — both were orphaned (never reachable through the gateway) and
were removed rather than wired in, since their functionality already lives in
auth-service and wallet-service respectively.
