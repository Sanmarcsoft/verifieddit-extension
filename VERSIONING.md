# Semantic Versioning Protocol

This project adheres to Semantic Versioning 2.0.0.

Given a version number MAJOR.MINOR.PATCH, increment the:

1.  **MAJOR** version when you make incompatible API changes,
2.  **MINOR** version when you add functionality in a backwards-compatible manner, and
3.  **PATCH** version when you make backwards-compatible bug fixes.

Additional labels for pre-release and build metadata are available as extensions to the MAJOR.MINOR.PATCH format.

## Initial Versioning

For the initial release of the `verifieddit` extension, the version will be set to `1.0.0`.

## Applying Semantic Versioning

-   **`package.json`**: The primary source for the project's version.
-   **`src/manifest.chrome.v3.json`**: Chrome extension manifest version.
-   **`src/manifest.firefox.v3.json`**: Firefox extension manifest version.
-   **`test/package.json`**: Version for the UAT test server.
-   **Documentation**: Any relevant documentation (e.g., UAT reports, plans) should reflect the current version.

## Extension Naming Convention

The extension name will be changed from `c2pa-extension-validator` to `verifieddit` across the codebase and documentation.