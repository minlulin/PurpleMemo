export default function App() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-6)",
      }}
    >
      <section
        style={{
          backgroundColor: "var(--color-surface)",
          border: "var(--border-width) solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--space-8)",
          maxWidth: "36rem",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--space-5)",
        }}
      >
        <img
          src="/brand/purple-memo-logo.png"
          alt="Purple Memo logo"
          style={{ width: "min(60vw, 11rem)", height: "auto" }}
        />
        <h1 style={{ margin: 0, fontSize: "var(--text-xl)" }}>Purple Memo</h1>
        <p style={{ margin: 0, color: "var(--color-text-muted)" }}>
          Personal offline notebook and life/money manager — desktop-only, fully
          offline, encrypted local database.
        </p>
        <p className="figure" style={{ color: "var(--color-accent)" }}>
          Phase P0 — scaffold ready. Local gate: npm run verify
        </p>
      </section>
    </main>
  );
}
