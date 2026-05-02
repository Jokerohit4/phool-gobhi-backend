package com.yourorg.paymentwallet.validation;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

import java.util.List;

public class ValidCurrencyValidator implements ConstraintValidator<ValidCurrency, String> {

    private static final List<String> SUPPORTED = List.of("INR", "USD", "EUR");

    @Override
    public boolean isValid(String value, ConstraintValidatorContext context) {
        if (value == null) return true; // default handled elsewhere
        return SUPPORTED.contains(value.toUpperCase());
    }
}
