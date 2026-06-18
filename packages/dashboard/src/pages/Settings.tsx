import React from "react";

export function Settings() {
  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold mb-6">Settings</h1>

      <div className="space-y-4">
        <div className="rounded-xl border border-gray-800 p-5">
          <h2 className="font-medium mb-3">Gmail OTP Setup</h2>
          <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
            <li>On each Amazon account's Gmail, go to <strong className="text-gray-300">Settings → Forwarding and POP/IMAP</strong></li>
            <li>Add forwarding address: your OTP receiver Gmail (e.g. <code className="bg-gray-800 px-1 rounded">otp-receiver@gmail.com</code>)</li>
            <li>In the OTP receiver Gmail, enable <strong className="text-gray-300">2-Step Verification</strong></li>
            <li>Go to <strong className="text-gray-300">Security → App Passwords</strong>, create one for "Mail"</li>
            <li>Set <code className="bg-gray-800 px-1 rounded">GMAIL_USER</code> and <code className="bg-gray-800 px-1 rounded">GMAIL_APP_PASSWORD</code> in your <code className="bg-gray-800 px-1 rounded">.env</code></li>
          </ol>
        </div>

        <div className="rounded-xl border border-gray-800 p-5">
          <h2 className="font-medium mb-3">Telegram Bot Setup</h2>
          <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
            <li>Message <code className="bg-gray-800 px-1 rounded">@BotFather</code> on Telegram → <code className="bg-gray-800 px-1 rounded">/newbot</code></li>
            <li>Copy the token → set <code className="bg-gray-800 px-1 rounded">TELEGRAM_BOT_TOKEN</code> in .env</li>
            <li>Send any message to your bot, then visit{" "}
              <code className="bg-gray-800 px-1 rounded">https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code></li>
            <li>Copy your chat_id → set <code className="bg-gray-800 px-1 rounded">TELEGRAM_ADMIN_CHAT_ID</code> in .env</li>
          </ol>
        </div>

        <div className="rounded-xl border border-gray-800 p-5">
          <h2 className="font-medium mb-3">Bright Data Proxy Setup</h2>
          <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
            <li>Sign up at <strong className="text-gray-300">brightdata.com</strong> → create a Residential zone</li>
            <li>Enable <strong className="text-gray-300">sticky sessions</strong> in zone settings</li>
            <li>Proxy URL format: <code className="bg-gray-800 px-1 rounded text-xs">http://brd-customer-CUST-zone-ZONE-session-ACCTID:PASSWORD@brd.superproxy.io:22225</code></li>
            <li>Add each proxy in the <strong className="text-gray-300">Proxies</strong> tab — one per account for isolation</li>
          </ol>
        </div>

        <div className="rounded-xl border border-gray-800 p-5">
          <h2 className="font-medium mb-3">Scaling Workers</h2>
          <p className="text-sm text-gray-400 mb-2">To run more workers simultaneously, scale the worker service:</p>
          <pre className="bg-gray-800 rounded-lg p-3 text-xs text-green-400 font-mono">docker compose up --scale worker=20 -d</pre>
          <p className="text-xs text-gray-600 mt-2">Each worker container handles one Amazon account. The orchestrator assigns accounts via BullMQ.</p>
        </div>
      </div>
    </div>
  );
}
