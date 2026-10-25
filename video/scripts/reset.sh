#!/bin/sh
# Puts the demo profile back to the freshly seeded account.
cd "$(dirname "$0")/.." && rm -rf capture-data/desktop-user/data && cp -R capture-data/pristine capture-data/desktop-user/data
