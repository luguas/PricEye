"""
Setup script for market_data_pipeline package.
"""

from setuptools import setup, find_packages

setup(
    name="market-data-pipeline",
    version="1.0.0",
    description="Pipeline de collecte et enrichissement de données marché pour pricing dynamique",
    author="PricEye Team",
    packages=find_packages(),
    install_requires=[
        "aiohttp>=3.9.0",
        "supabase>=2.0.0",
        "pandas>=2.0.0",
        "numpy>=1.24.0",
        "python-dotenv>=1.0.0",
        "pytz>=2023.3",
        "python-dateutil>=2.8.0",
    ],
    python_requires=">=3.9",
)









