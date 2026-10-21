#!/usr/bin/env bash
set -euo pipefail

# Runs the bot from its own directory: it reads .env (or .env.personal) and keeps its WhatsApp session in .auth*,
# all relative to here. Any argument is passed on to the bot, so the personal mode is:
#
#   ./start_dev.sh --mode=personal
cd "$(dirname "$0")"

log() {
    echo "[start_dev.sh] $1"
}

install_dependencies_if_missing() {
    # Only when they are missing, unlike the API's script: this one is what the systemd service runs, and a service
    # that restarts on failure must not hit the network on every try. Run `npm ci` by hand after changing the lockfile.
    if [ ! -d node_modules ]; then
        log "Installing dependencies (npm ci)"
        npm ci
    fi
}

# Which file the bot is going to read, so a missing one is reported here instead of starting without settings.
env_file_for() {
    local previous=""
    for arg in "$@"; do
        if [ "$arg" = "--mode=personal" ] || { [ "$previous" = "--mode" ] && [ "$arg" = "personal" ]; }; then
            echo ".env.personal"
            return
        fi
        previous="$arg"
    done
    if [ "${APP_ENV:-}" = "prod" ]; then
        echo ".env.prod"
    else
        echo ".env"
    fi
}

run_bot() {
    local env_file
    env_file="$(env_file_for "$@")"
    if [ ! -f "$env_file" ]; then
        log "Missing $env_file — copy .env.default to $env_file and fill it in"
        exit 1
    fi
    log "Starting the bot (reads $env_file)"
    # exec: the bot becomes this process, so systemd watches it and a stop signal reaches it directly.
    exec node src/index.ts "$@"
}

main() {
    install_dependencies_if_missing
    run_bot "$@"
}

main "$@"
