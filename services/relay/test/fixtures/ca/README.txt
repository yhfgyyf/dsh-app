Public test-only CA, server certificate and server private key. Never use these keys outside isolated tests. The original valid CA private key is not retained. The expired CA key is retained only for certificate validation tests. The server certificate has IP SAN 127.0.0.1.

The renewal-old-ca.pem and renewal-ca.pem fixtures reuse the expired test CA key with valid dates and different common names. renewal-server.pem uses the existing test server key and IP SAN 127.0.0.1, signed by renewal-ca.pem. They test certificate renewal with an unchanged trust key and must never be deployed.
