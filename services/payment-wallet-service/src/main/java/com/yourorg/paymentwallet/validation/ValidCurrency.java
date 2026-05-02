package com.yourorg.paymentwallet.validation;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;
import java.lang.annotation.*;

@Documented
@Constraint(validatedBy = ValidCurrencyValidator.class)
@Target({ElementType.FIELD, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
public @interface ValidCurrency {

    String message() default "Unsupported currency type";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}
