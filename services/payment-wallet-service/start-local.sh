#!/bin/bash

# Script to start the application with H2 in-memory database for local testing
# This bypasses the PostgreSQL connection issue

echo "Starting Payment Wallet Service with H2 database (local profile)..."
echo "Application will be available at: http://localhost:8082"
echo "H2 Console available at: http://localhost:8082/h2-console"
echo ""
echo "Press Ctrl+C to stop"
echo ""

mvn spring-boot:run -Dspring-boot.run.profiles=local



