import { useEffect } from "react";

function App() {
  useEffect(() => {
    window.location.replace("/toolkit.html");
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#020817", color: "#7ee8fa", fontFamily: "system-ui, sans-serif" }}>
      <div>Loading Okiru AI Tool Advisor...</div>
    </div>
  );
}

export default App;
