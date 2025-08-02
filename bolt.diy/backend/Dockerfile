# Build stage
FROM golang:1.23 as builder
WORKDIR /go/src/app
COPY ./backend/ .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o /go/bin/app

# Production stage
FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=builder /go/bin/app /app
EXPOSE 3001
CMD ["/app"]

