FROM golang:1.23-alpine AS builder

RUN apk add --no-cache gcc musl-dev

WORKDIR /app
COPY go.mod ./
COPY . .
RUN go mod tidy && CGO_ENABLED=1 go build -o dashboard .

FROM alpine:3.20

RUN apk add --no-cache ca-certificates sqlite-libs
COPY --from=builder /app/dashboard /usr/local/bin/dashboard

EXPOSE 8080
ENTRYPOINT ["dashboard"]
