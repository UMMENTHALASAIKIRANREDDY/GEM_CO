---
title: "GEM_CO Overview"
type: overview
created: 2026-04-13
---

# GEM_CO — Project Overview

## What It Is

GEM_CO is a CloudFuze file migration and correlation application built with Node.js. It provides a web UI for managing and processing cloud file migrations.

## Tech Stack

- **Backend:** Node.js, Express (`server.js`)
- **Core Logic:** `src/modules/fileCorrelator.js` — handles file correlation
- **Frontend:** HTML/CSS/JS in `ui/`
- **Infrastructure:** Docker (`Dockerfile`, `docker-compose.yml`)
- **Config:** `.env` for environment variables

## Key Modules

- `fileCorrelator.js` — Core file matching and correlation engine
- `server.js` — REST API and web server

## Wiki Mode

Mode B: GitHub/Codebase wiki — tracks architecture, modules, and decisions.
