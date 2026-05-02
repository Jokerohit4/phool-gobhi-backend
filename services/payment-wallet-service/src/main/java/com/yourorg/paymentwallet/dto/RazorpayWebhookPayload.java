package com.yourorg.paymentwallet.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.math.BigDecimal;

@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class RazorpayWebhookPayload {
    private String event;
    private PaymentPayload payload;
    
    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class PaymentPayload {
        private PaymentEntity payment;
        
        @Data
        @JsonIgnoreProperties(ignoreUnknown = true)
        public static class PaymentEntity {
            private PaymentData entity;
            
            @Data
            @JsonIgnoreProperties(ignoreUnknown = true)
            public static class PaymentData {
                private String id;
                
                @JsonProperty("order_id")
                private String orderId;
                
                private String status;
                private BigDecimal amount;
            }
        }
    }
}

