"""Kalshi API authentication using RSA-PSS signatures."""

import time
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


def load_private_key(key_path: str):
    key_bytes = Path(key_path).read_bytes()
    return serialization.load_pem_private_key(key_bytes, password=None)


def sign_request(private_key, method: str, path: str, timestamp_ms: int) -> str:
    """Sign a Kalshi API request with RSA-PSS.

    The signature message is: timestamp_ms + method + path
    """
    message = f"{timestamp_ms}{method}{path}".encode()
    signature = private_key.sign(
        message,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.MAX_LENGTH,
        ),
        hashes.SHA256(),
    )
    import base64

    return base64.b64encode(signature).decode()


def auth_headers(private_key, api_key_id: str, method: str, path: str) -> dict:
    """Generate the three auth headers required by Kalshi."""
    ts = int(time.time() * 1000)
    signature = sign_request(private_key, method, path, ts)
    return {
        "KALSHI-ACCESS-KEY": api_key_id,
        "KALSHI-ACCESS-TIMESTAMP": str(ts),
        "KALSHI-ACCESS-SIGNATURE": signature,
    }
