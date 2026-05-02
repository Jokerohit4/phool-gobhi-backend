#!/bin/bash

# Payment Wallet Service API Test Script
# Make sure the application is running on http://localhost:8082

BASE_URL="http://localhost:8082/api"

echo "=========================================="
echo "Payment Wallet Service API Tests"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Health Check
echo -e "${BLUE}1. Health Check${NC}"
echo "GET $BASE_URL/wallet/health"
curl -X GET "$BASE_URL/wallet/health" \
  -H "Content-Type: application/json" \
  -w "\nStatus: %{http_code}\n\n"

# 2. Create Wallet
echo -e "${BLUE}2. Create Wallet${NC}"
echo "POST $BASE_URL/wallet"
echo "Request Body:"
cat <<EOF
{
  "userId": 1,
  "userType": "customer",
  "currency": "INR"
}
EOF
echo ""
WALLET_RESPONSE=$(curl -s -X POST "$BASE_URL/wallet" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 1,
    "userType": "customer",
    "currency": "INR"
  }' \
  -w "\nStatus: %{http_code}")

echo "$WALLET_RESPONSE"
echo ""

# 3. Get Wallet
echo -e "${BLUE}3. Get Wallet${NC}"
echo "GET $BASE_URL/wallet/1"
curl -X GET "$BASE_URL/wallet/1" \
  -H "Content-Type: application/json" \
  -w "\nStatus: %{http_code}\n\n"

# 4. Credit Wallet
echo -e "${BLUE}4. Credit Wallet${NC}"
echo "POST $BASE_URL/wallet/1/credit"
echo "Request Body:"
cat <<EOF
{
  "amount": 1000.0,
  "description": "Initial deposit"
}
EOF
echo ""
curl -X POST "$BASE_URL/wallet/1/credit" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 1000.0,
    "description": "Initial deposit"
  }' \
  -w "\nStatus: %{http_code}\n\n"

# 5. Get Transactions
echo -e "${BLUE}5. Get Transactions${NC}"
echo "GET $BASE_URL/wallet/1/transactions"
curl -X GET "$BASE_URL/wallet/1/transactions" \
  -H "Content-Type: application/json" \
  -w "\nStatus: %{http_code}\n\n"

# 6. Debit Wallet
echo -e "${BLUE}6. Debit Wallet${NC}"
echo "POST $BASE_URL/wallet/1/debit"
echo "Request Body:"
cat <<EOF
{
  "amount": 250.0,
  "description": "Purchase"
}
EOF
echo ""
curl -X POST "$BASE_URL/wallet/1/debit" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 250.0,
    "description": "Purchase"
  }' \
  -w "\nStatus: %{http_code}\n\n"

# 7. Create Payment Order (Razorpay)
echo -e "${BLUE}7. Create Payment Order (Razorpay)${NC}"
echo "POST $BASE_URL/payment/order"
echo "Request Body:"
cat <<EOF
{
  "walletId": 1,
  "amount": 500.0,
  "description": "Wallet topup"
}
EOF
echo ""
PAYMENT_ORDER_RESPONSE=$(curl -s -X POST "$BASE_URL/payment/order" \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": 1,
    "amount": 500.0,
    "description": "Wallet topup"
  }' \
  -w "\nStatus: %{http_code}")

echo "$PAYMENT_ORDER_RESPONSE"
echo ""

# 8. Test Error Cases
echo -e "${YELLOW}8. Testing Error Cases${NC}"
echo ""

echo -e "${YELLOW}8a. Get Non-existent Wallet${NC}"
curl -X GET "$BASE_URL/wallet/999" \
  -H "Content-Type: application/json" \
  -w "\nStatus: %{http_code}\n\n"

echo -e "${YELLOW}8b. Debit with Insufficient Balance${NC}"
curl -X POST "$BASE_URL/wallet/1/debit" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100000.0,
    "description": "Large purchase"
  }' \
  -w "\nStatus: %{http_code}\n\n"

echo -e "${YELLOW}8c. Create Wallet with Invalid Data${NC}"
curl -X POST "$BASE_URL/wallet" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": null,
    "userType": "",
    "currency": "USD"
  }' \
  -w "\nStatus: %{http_code}\n\n"

echo -e "${GREEN}=========================================="
echo "All tests completed!"
echo "==========================================${NC}"

