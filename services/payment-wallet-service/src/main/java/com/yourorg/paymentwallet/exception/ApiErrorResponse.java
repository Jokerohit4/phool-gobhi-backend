package com.yourorg.paymentwallet.exception;

import lombok.Builder;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@Builder
public class ApiErrorResponse {
    @Builder.Default
    private LocalDateTime timestamp = LocalDateTime.now();
     int status;
    private String error;
    private String errorCode;
    private String message;
    private String path;
}