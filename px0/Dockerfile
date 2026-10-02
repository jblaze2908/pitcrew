# Read-only code view: px0 (MIT, https://github.com/px0-ai/px0), run per open project by app/src/code.ts.
# Pinned to a release at least 7 days old (v0.1.9 is the first with -base-path); the checksum is the one published
# in that release's checksums.txt, so a swapped binary fails the build.
FROM alpine:3.22
ARG PX0_VERSION=0.1.9
ARG PX0_SHA256=63945baf3e9f2fe0f6a21cc67b7b23b0f2a537649f9c128a034c7dbb6a9bad83
RUN apk add --no-cache git ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/px0 "https://github.com/px0-ai/px0/releases/download/v${PX0_VERSION}/px0-${PX0_VERSION}-linux-amd64" \
 && echo "${PX0_SHA256}  /usr/local/bin/px0" | sha256sum -c - \
 && chmod 755 /usr/local/bin/px0 \
 && apk del curl
USER 1500:1500
ENTRYPOINT ["/usr/local/bin/px0"]
