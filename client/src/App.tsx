import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { Navbar } from "./components/Navbar";
import Home from "./pages/Home";
import SpotList from "./pages/SpotList";
import SpotDetail from "./pages/SpotDetail";
import SearchPage from "./pages/SearchPage";
import SubmitSpot from "./pages/SubmitSpot";
import AgentSearch from "./pages/AgentSearch";
import { WanderingCat } from "./components/WanderingCat";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/spots" component={SpotList} />
      <Route path="/spots/:id" component={SpotDetail} />
      <Route path="/search" component={SearchPage} />
      <Route path="/submit" component={SubmitSpot} />
      <Route path="/agent" component={AgentSearch} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Navbar />
          <Router />
          <WanderingCat />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
