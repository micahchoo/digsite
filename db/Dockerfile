# Postgres with pgvector, on the SAME base the database already runs on.
# The official pgvector images are Debian (glibc); moving an Alpine (musl)
# data directory to glibc changes text collation under existing indexes,
# which then need rebuilding. Building the extension here keeps the C
# library, and so every index, unchanged.
#
# with_llvm=no: the extension's JIT bitcode is optional, and building it
# would need this image's exact clang. OPTFLAGS="": no -march=native, so the
# image runs on any x86-64 host, not only the one that built it.
FROM postgres:16-alpine
ARG PGVECTOR_VERSION=v0.8.6
RUN apk add --no-cache --virtual .build-deps git build-base \
 && git clone --depth 1 --branch "$PGVECTOR_VERSION" \
      https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && make -C /tmp/pgvector with_llvm=no OPTFLAGS="" \
 && make -C /tmp/pgvector with_llvm=no install \
 && rm -rf /tmp/pgvector \
 && apk del .build-deps
