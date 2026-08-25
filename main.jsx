import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './ghadir_academy.jsx'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Uncaught React Error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          fontFamily: "'Cairo', sans-serif",
          direction: "rtl",
          background: "#0F0B1E",
          color: "#FFFFFF",
          textAlign: "center"
        }}>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>⚠️</div>
          <h1 style={{ fontSize: "22px", fontWeight: 800, marginBottom: "12px", color: "#F87171" }}>
            حدث خطأ في تحميل التطبيق
          </h1>
          <p style={{ fontSize: "14px", color: "#A78BFA", marginBottom: "24px", maxWidth: "400px", lineHeight: "1.6" }}>
            يرجى إعادة تحديث الصفحة أو تسجيل الخروج وإعادة الدخول.
          </p>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              onClick={() => {
                localStorage.removeItem('ghadir_logged_user');
                localStorage.removeItem('ghadir_token');
                sessionStorage.clear();
                window.location.reload();
              }}
              style={{
                background: "#2563EB",
                color: "#FFFFFF",
                border: "none",
                borderRadius: "8px",
                padding: "10px 20px",
                fontSize: "14px",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              إعادة التحميل وتحديث الجلسة
            </button>
          </div>
          {this.state.error && (
            <pre style={{ marginTop: "24px", padding: "12px", background: "rgba(255,255,255,0.05)", borderRadius: "8px", fontSize: "11px", color: "#FCA5A5", direction: "ltr", textAlign: "left", maxWidth: "90vw", overflowX: "auto" }}>
              {String(this.state.error.stack || this.state.error.message || this.state.error)}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
