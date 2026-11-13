# Phool Gobhi Type Registry

This directory serves as the Single Source of Truth (SSOT) for all data models and API contracts across the platform.

## Workflow
1. **Update Spec**: Modify the `specs/` YAML file for the relevant service.
2. **Verify**: Ensure the backend service implementation matches the spec.
3. **Generate**: Run `./generate-types.sh` to propagate changes.

## Registry Structure
- `/specs`: OpenAPI 3.0 YAML definitions for each microservice.
- `/generated`: Target directory for generated TS and Dart code (should be gitignored in target repos).
- `generate-types.sh`: Orchestration script for the generation pipeline.
