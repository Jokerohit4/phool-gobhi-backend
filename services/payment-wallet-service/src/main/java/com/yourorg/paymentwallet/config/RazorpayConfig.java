package com.yourorg.paymentwallet.config;

import com.razorpay.RazorpayClient;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Slf4j
@Configuration
public class RazorpayConfig {
    private final String keyId;
    private final String keySecret;

    public RazorpayConfig(
            @Value("${razorpay.key.id}") String keyId,
            @Value("${razorpay.key.secret}") String keySecret) {
        this.keyId = keyId;
        this.keySecret = keySecret;
    }

    @Bean
    public RazorpayClient razorpayClient() {
        log.info("========== RAZORPAY CONFIG DEBUG ==========");
        log.info("Key ID length: {}", keyId != null ? keyId.length() : "NULL");
        log.info("Key ID starts with: {}", keyId != null ? keyId.substring(0, Math.min(15, keyId.length())) : "NULL");
        log.info("Key Secret length: {}", keySecret != null ? keySecret.length() : "NULL");
        log.info("Key Secret starts with: {}", keySecret != null ? keySecret.substring(0, Math.min(10, keySecret.length())) : "NULL");
        log.info("==========================================");

        if (keyId == null || keySecret == null) {
            throw new IllegalArgumentException("Razorpay credentials are null! Check application.properties");
        }

        if (keyId.trim().isEmpty() || keySecret.trim().isEmpty()) {
            throw new IllegalArgumentException("Razorpay credentials are empty! Check application.properties");
        }

        try {
            return new RazorpayClient(keyId.trim(), keySecret.trim());
        } catch (Exception e) {
            throw new RuntimeException("Failed to initialize Razorpay client", e);
        }
    }
}