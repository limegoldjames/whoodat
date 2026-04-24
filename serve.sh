#!/bin/bash
echo "Stopping any running http.server..."
pkill -f "python3 -m http.server" 2>/dev/null && echo "Stopped." || echo "None running."
sleep 1
echo "Starting server on http://localhost:8000"
python3 -m http.server 8000
