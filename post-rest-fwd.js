#!/usr/bin/env node
/**
 * postfix_to_rest.js - Forward incoming emails from Postfix to a REST API.
 * Reads a raw RFC822 email from stdin and POSTs it to the configured URL.
 */

'use strict';

const fs = require('fs');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;

// --- Configuration ---
const REST_URL = 'https://example.com/api/incoming-email';
const API_TOKEN = process.env.API_TOKEN || 'your-secret-token-here';
const TIMEOUT_MS = 30000;
const LOG_FILE = '/var/log/postfix_to_rest.log';

// Postfix exit codes (from sysexits.h) - critical for proper handling
const EX_OK = 0;
const EX_TEMPFAIL = 75;     // Postfix will retry later
const EX_UNAVAILABLE = 69;  // Permanent failure, bounce the message

function log(level, message) {
  const line = `${new Date().toISOString()} ${level} ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    process.stderr.write(line);
  }
}

// Configure axios with retry on transient errors
const client = axios.create({ timeout: TIMEOUT_MS });
axiosRetry(client, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return (
      axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      (error.response && error.response.status >= 500)
    );
  },
});

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

function buildPayload(parsed, rawSize) {
  const addrList = (field) => {
    if (!field) return [];
    const values = Array.isArray(field) ? field : [field];
    return values.flatMap((v) => (v.value || []).map((a) => a.address));
  };

  return {
    message_id: parsed.messageId || '',
    date: parsed.date ? parsed.date.toISOString() : '',
    from: {
      name: parsed.from?.value?.[0]?.name || '',
      address: parsed.from?.value?.[0]?.address || '',
    },
    to: addrList(parsed.to),
    cc: addrList(parsed.cc),
    subject: parsed.subject || '',
    text: parsed.text || null,
    html: parsed.html || null,
    raw_size_bytes: rawSize,
  };
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw || raw.length === 0) {
      log('ERROR', 'Empty input from Postfix');
      return EX_UNAVAILABLE;
    }

    const parsed = await simpleParser(raw);
    const payload = buildPayload(parsed, raw.length);

    log(
      'INFO',
      `Forwarding message_id=${payload.message_id} from=${payload.from.address} subject=${JSON.stringify(payload.subject)}`
    );

    try {
      const response = await client.post(REST_URL, payload, {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      log('INFO', `Delivered OK (${response.status})`);
      return EX_OK;
    } catch (err) {
      if (err.response) {
        const status = err.response.status;
        if (status >= 500) {
          log('WARN', `Server error ${status} after retries - will retry via Postfix`);
          return EX_TEMPFAIL;
        }
        const body = JSON.stringify(err.response.data).slice(0, 500);
        log('ERROR', `Permanent failure ${status}: ${body}`);
        return EX_UNAVAILABLE;
      }
      // Network error, timeout, DNS, etc.
      log('WARN', `Network error, asking Postfix to retry: ${err.message}`);
      return EX_TEMPFAIL;
    }
  } catch (err) {
    log('ERROR', `Unexpected error: ${err.stack || err.message}`);
    return EX_TEMPFAIL; // safer to retry than lose mail
  }
}

main().then((code) => process.exit(code));