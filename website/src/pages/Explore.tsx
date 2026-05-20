import { useState, useEffect } from "react";
import { useSearchParams, useParams } from "react-router-dom";
import CodeGraphViewer from "../components/CodeGraphViewer";
import LocalUploader from "../components/LocalUploader";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import JSZip from "jszip";
import { parseFilesIntoGraph } from "../lib/parser";
import { parseFilesWithPyodide } from "../lib/parser-pyodide";

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.github', 'dist', 'build', 'out', 'coverage', 
  '.next', '.nuxt', '__pycache__', 'venv', '.venv', 'env', '.env', '.tox',
  'eggs', 'target', '.gradle', '.idea', 'cmake-build-debug', 'bin', 'obj',
  'packages', 'vendor', 'Pods', '.build', 'DerivedData', '.dart_tool',
  '.vscode'
]);

const isPathIgnored = (path: string) => {
  const parts = path.split(/[\/\\]/);
  return parts.some(part => IGNORED_DIRS.has(part));
};

const sanitizePath = (pathStr: string, repoName?: string): string => {
  if (!pathStr) return '';
  
  // Normalize Windows slashes
  let p = pathStr.replace(/\\/g, '/');
  
  // If it's already relative, just return it
  if (p.startsWith('.') || (!p.startsWith('/') && !p.match(/^[a-zA-Z]:\//))) {
    return p.startsWith('./') ? p : './' + p;
  }
  
  // Detect if we can make it relative using the repoName
  if (repoName) {
    const parts = p.split('/');
    const repoIndex = parts.lastIndexOf(repoName);
    if (repoIndex !== -1) {
      return './' + parts.slice(repoIndex).join('/');
    }
  }
  
  // Generic cleanup for absolute paths
  const segments = p.split('/').filter(Boolean);
  if (segments.length > 3) {
    if (p.startsWith('/home/') || p.startsWith('/Users/') || p.includes('/runner/work/')) {
      return './' + segments.slice(-3).join('/');
    }
  }
  
  return p;
};

const Explore = () => {
  const [searchParams] = useSearchParams();
  const { owner, repo } = useParams();
  const [graphData, setGraphData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressText, setProgressText] = useState("");
  const [progressValue, setProgressValue] = useState(0);

  // Connection parameters for "Playground" mode (CLI/Database)
  const backend = searchParams.get("backend") || "";
  const repoPath = searchParams.get("repo_path") || "";
  const cypherQuery = searchParams.get("cypher_query") || "";
  const bundleUrl = searchParams.get("bundle_url") || "";
  
  // Helper to fetch files using a sequential pool of robust CORS proxies
  const fetchWithFallbackProxies = async (url: string): Promise<Response> => {
    if (!url) throw new Error("URL is empty");
    
    // Try direct fetch first (essential for localhost, relative URLs, or CORS-enabled endpoints)
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch (e) {
      console.warn("Direct fetch failed, falling back to CORS proxies...", e);
    }
    
    // 1. Check raw githubusercontent.com to bypass proxy using jsDelivr CDN directly
    if (url.includes("raw.githubusercontent.com")) {
      const match = url.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/);
      if (match) {
        const [_, ownerName, repoName, branch, filepath] = match;
        const jsdelivrUrl = `https://cdn.jsdelivr.net/gh/${ownerName}/${repoName}@${branch}/${filepath}`;
        try {
          const res = await fetch(jsdelivrUrl);
          if (res.ok) return res;
        } catch (e) {
          console.warn("jsDelivr CDN fetch failed, falling back to CORS proxies...", e);
        }
      }
    }

    const proxies = [
      // Proxy 1: corsproxy.io (Very fast, but sometimes blocks large zips)
      (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      // Proxy 2: allorigins.win (Extremely reliable for release assets & large archives)
      (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      // Proxy 3: thingproxy.freeboard.io (Fallback proxy)
      (u: string) => `https://thingproxy.freeboard.io/fetch/${u}`
    ];

    let lastError: any = null;
    for (const proxy of proxies) {
      try {
        const proxiedUrl = proxy(url);
        console.log(`[Proxy] Attempting fetch: ${proxiedUrl}`);
        const res = await fetch(proxiedUrl);
        if (res.ok) return res;
        if (res.status === 403 || res.status === 429) {
          console.warn(`[Proxy] Status ${res.status} received. Trying next proxy...`);
          continue;
        }
        return res; // Return regular errors (like 404) directly to avoid looping
      } catch (err) {
        lastError = err;
        console.warn("[Proxy] Connection failed, trying next fallback proxy...", err);
      }
    }
    throw lastError || new Error("Failed to fetch via all available CORS proxies.");
  };

  // If owner and repo path parameters are present, auto-fetch and index the codebase!
  useEffect(() => {
    if (!owner || !repo) return;
    
    // Ignore static routes like "explore" getting caught as owner/repo
    if (owner.toLowerCase() === "explore") return;

    const autoFetchAndIndex = async () => {
      setLoading(true);
      setError(null);
      
      let files: any[] = [];
      let fileContents: Record<string, string> = {};
      let method2Success = false;

      try {
        // --- METHOD 1: ZIP ARCHIVE FLOW (PRIMARY & HIGHLY OPTIMIZED) ---
        setProgressText("Downloading repository zip archive (highly optimized)...");
        setProgressValue(10);
        
        let response = null;

        // TIER 1: Standard Web Archive ZIP (Rate-Limit Free) via CORS Proxies
        try {
          console.log("[Explore] Tier 1: Fetching standard web ZIP archive via proxies...");
          const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`;
          response = await fetchWithFallbackProxies(zipUrl);
          if (!response || !response.ok) throw new Error(`Status ${response?.status}`);
        } catch (err1) {
          console.warn("[Explore] Tier 1 main.zip failed, trying master.zip...", err1);
          try {
            const fallbackZipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/master.zip`;
            response = await fetchWithFallbackProxies(fallbackZipUrl);
            if (!response || !response.ok) throw new Error(`Status ${response?.status}`);
          } catch (err2) {
            console.warn("[Explore] Tier 1 master.zip failed as well.", err2);
          }
        }

        // TIER 2: If Tier 1 failed, fallback to REST API Zipball (Direct / Proxied)
        if (!response || !response.ok) {
          console.log("[Explore] Tier 2: Falling back to REST API Zipball...");
          try {
            const apiZipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/main`;
            response = await fetchWithFallbackProxies(apiZipUrl);
            if (!response || !response.ok) throw new Error(`Status ${response?.status}`);
          } catch (err3) {
            console.warn("[Explore] Tier 2 main zipball failed, trying master zipball...", err3);
            try {
              const fallbackApiZipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/master`;
              response = await fetchWithFallbackProxies(fallbackApiZipUrl);
              if (!response || !response.ok) throw new Error(`Status ${response?.status}`);
            } catch (err4) {
              console.error("[Explore] Tier 2 master zipball failed as well.", err4);
              throw new Error("All ZIP download tiers failed.");
            }
          }
        }

        setProgressText("Unzipping archive in-memory...");
        setProgressValue(30);
        const buffer = await response.arrayBuffer();
        const jszip = await JSZip.loadAsync(buffer);
        
        const promises: Promise<void>[] = [];
        
        jszip.forEach((path, entry) => {
          if (
            !entry.dir && 
            path.match(/\.(js|ts|jsx|tsx|py|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|kts|dart)$/) && 
            !isPathIgnored(path)
          ) {
            promises.push(
              entry.async("text").then((content) => {
                // Strip the GitHub zipball root folder segment (e.g. "owner-repo-commitHash/")
                const cleanPath = path.substring(path.indexOf("/") + 1);
                files.push({ path: cleanPath, content });
              })
            );
          }
        });
        
        if (promises.length === 0) {
          throw new Error("No parseable code files found in the repository.");
        }
        
        setProgressText(`Extracting ${promises.length} files...`);
        setProgressValue(45);
        await Promise.all(promises);

        for (const f of files) {
          fileContents[f.path] = f.content;
        }

        method2Success = true;
        console.log(`[ZIP Flow] Successfully downloaded and extracted ${files.length} files.`);
        
      } catch (zipErr: any) {
        console.warn("[ZIP Flow] Failed, falling back to CDN individual file downloads...", zipErr);
        files = [];
        fileContents = {};

        // --- METHOD 2: FALLBACK FAST CDN FLOW ---
        setProgressText("Fetching repository structure from GitHub...");
        setProgressValue(5);
        
        let treeResponse: Response;
        let activeBranch = "main";
        
        try {
          treeResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=true`);
          if (!treeResponse.ok) throw new Error("main branch not found or rate limited");
        } catch (e) {
          activeBranch = "master";
          treeResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/master?recursive=true`);
          if (!treeResponse.ok) {
            throw new Error(`Failed to fetch tree from GitHub REST API (Status ${treeResponse.status})`);
          }
        }
        
        const treeData = await treeResponse.json();
        if (!treeData || !Array.isArray(treeData.tree)) {
          throw new Error("Invalid tree data received from GitHub");
        }
        
        // Filter files matching our source-code pattern
        const candidateFiles = treeData.tree.filter((item: any) => 
          item.type === "blob" &&
          item.path.match(/\.(js|ts|jsx|tsx|py|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|kts|dart)$/) &&
          !isPathIgnored(item.path)
        );
        
        if (candidateFiles.length === 0) {
          throw new Error("No parseable code files found in the repository tree.");
        }
        
        setProgressText(`Found ${candidateFiles.length} code files. Downloading in parallel...`);
        setProgressValue(15);
        
        // Download files in parallel with paced batching to avoid overloading browser connections
        const BATCH_SIZE = 15;
        let downloadedCount = 0;
        
        for (let i = 0; i < candidateFiles.length; i += BATCH_SIZE) {
          const batch = candidateFiles.slice(i, i + BATCH_SIZE);
          
          await Promise.all(
            batch.map(async (file: any) => {
              const fileUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${activeBranch}/${file.path}`;
              try {
                const fileRes = await fetch(fileUrl);
                if (!fileRes.ok) throw new Error(`Status ${fileRes.status}`);
                const content = await fileRes.text();
                files.push({ path: file.path, content });
                fileContents[file.path] = content;
              } catch (err) {
                // If jsDelivr fails, try a direct raw github fallback
                try {
                  const fallbackUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${activeBranch}/${file.path}`;
                  const fileRes = await fetch(fallbackUrl);
                  if (!fileRes.ok) throw new Error(`Status ${fileRes.status}`);
                  const content = await fileRes.text();
                  files.push({ path: file.path, content });
                  fileContents[file.path] = content;
                } catch (e2) {
                  console.warn(`Failed to fetch file content for ${file.path}:`, err, e2);
                }
              } finally {
                downloadedCount++;
                const progress = 15 + Math.min(35, Math.floor((downloadedCount / candidateFiles.length) * 35));
                setProgressText(`Downloading files (${downloadedCount}/${candidateFiles.length})...`);
                setProgressValue(progress);
              }
            })
          );
        }
        
        if (files.length === 0) {
          throw new Error("Failed to download any code files from the CDN.");
        }
      }

      // --- COMMON SEMANTIC INDEXING PHASE ---
      try {
        setProgressText("Initializing WebAssembly semantic engine...");
        setProgressValue(60);
        
        const graphData = await parseFilesIntoGraph(
          files,
          (msg, val) => {
            setProgressText(msg);
            setProgressValue(val);
          },
          { indexVariables: true }
        );
        
        setProgressText("Complete!");
        setProgressValue(100);
        await new Promise((r) => setTimeout(r, 450));
        
        setGraphData({ ...graphData, fileContents });
      } catch (err: any) {
        console.error("Auto-Index Error:", err);
        setError(err.message);
        toast.error("Auto-Indexing failed: " + err.message);
      } finally {
        setLoading(false);
      }
    };

    autoFetchAndIndex();
  }, [owner, repo]);
  
  // If bundleUrl is present, we download and parse it client-side
  useEffect(() => {
    if (!bundleUrl) return;

    const fetchBundle = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetchWithFallbackProxies(bundleUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch bundle from URL (${response.status})`);
        }
        
        const buffer = await response.arrayBuffer();
        const jszip = await JSZip.loadAsync(buffer);
        
        const nodesFile = jszip.file("nodes.jsonl");
        const edgesFile = jszip.file("edges.jsonl");
        
        if (!nodesFile || !edgesFile) {
          throw new Error("Invalid CGC bundle: nodes.jsonl and edges.jsonl are required.");
        }
        
        let metadata: any = {};
        if (jszip.file("metadata.json")) {
          const metaText = await jszip.file("metadata.json")!.async("text");
          try {
            metadata = JSON.parse(metaText);
          } catch (e) {
            console.warn("Could not parse metadata.json", e);
          }
        }
        
        const repoName = metadata.repo || "";
        
        const nodesText = await nodesFile.async("text");
        const nodeLines = nodesText.split("\n").filter(line => line.trim() !== "");
        const nodes = nodeLines.map((line, idx) => {
          try {
            const nodeData = JSON.parse(line);
            const labels = nodeData._labels || [];
            const id = nodeData._id;
            
            // Extract properties
            const properties: Record<string, any> = {};
            for (const key of Object.keys(nodeData)) {
              if (key !== '_labels' && key !== '_id') {
                properties[key] = nodeData[key];
              }
            }
            
            // Clean absolute paths in node properties
            for (const key of Object.keys(properties)) {
              if (typeof properties[key] === 'string') {
                const val = properties[key];
                if (val.startsWith('/') || val.match(/^[a-zA-Z]:\\/) || val.includes('\\') || val.includes('/')) {
                  if (key === 'path' || key === 'file' || key === 'repo_path' || key === 'import_path') {
                    properties[key] = sanitizePath(val, repoName);
                  }
                }
              }
            }
            
            let displayName = String(properties.name || properties.label || properties.path || 'Unknown');
            if (displayName.startsWith('/') || displayName.includes('\\') || displayName.includes('/')) {
              displayName = sanitizePath(displayName, repoName);
            }
            
            const type = labels[0] ? (labels[0].charAt(0).toUpperCase() + labels[0].slice(1)) : 'Other';
            
            return {
              id: String(id),
              name: displayName,
              label: displayName,
              type: type,
              file: String(properties.path || properties.file || ''),
              val: (labels.length > 0 && ['Repository', 'Class', 'Interface', 'Trait'].includes(labels[0])) ? 4 : 2,
              properties: properties
            };
          } catch (err) {
            console.error("Failed to parse node line at index", idx, err);
            return null;
          }
        }).filter(Boolean);
        
        const edgesText = await edgesFile.async("text");
        const edgeLines = edgesText.split("\n").filter(line => line.trim() !== "");
        const links = edgeLines.map((line, idx) => {
          try {
            const edgeData = JSON.parse(line);
            return {
              id: `${edgeData.from}_to_${edgeData.to}_${edgeData.type}_${idx}`,
              source: String(edgeData.from),
              target: String(edgeData.to),
              type: String(edgeData.type).toUpperCase()
            };
          } catch (err) {
            console.error("Failed to parse edge line at index", idx, err);
            return null;
          }
        }).filter(Boolean);
        
        const filePaths: string[] = [];
        for (const n of nodes as any[]) {
          if (n.file && n.type.toLowerCase() === 'file') {
            filePaths.push(n.file);
          }
        }
        const sortedFiles = Array.from(new Set(filePaths)).sort();
        
        setGraphData({
          nodes,
          links,
          files: sortedFiles,
          fileContents: {},
          metadata
        });
      } catch (err: any) {
        console.error("Fetch Bundle Error:", err);
        setError(err.message);
        toast.error("Failed to load bundle: " + err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchBundle();
  }, [bundleUrl]);

  // If backend param is present, we automatically fetch from the local python server
  useEffect(() => {
    if (!backend && !cypherQuery) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/graph", backend || window.location.origin);
        if (repoPath) url.searchParams.append("repo_path", repoPath);
        if (cypherQuery) url.searchParams.append("cypher_query", cypherQuery);

        const response = await fetch(url.toString());
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.detail || `Server error (${response.status})`);
        }

        const data = await response.json();
        setGraphData(data);
      } catch (err: any) {
        console.error("Fetch Error:", err);
        setError(err.message);
        toast.error("Failed to connect to local index: " + err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [backend, repoPath, cypherQuery]);

  if (loading) {
    const isAutoIndexing = owner && repo && owner.toLowerCase() !== "explore";
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-center px-6 w-full relative overflow-hidden">
        {/* Glow ambient background effects */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-purple-500/10 rounded-full blur-[120px] pointer-events-none" />
        
        <div className="w-full max-w-md mx-auto flex flex-col items-center justify-center relative z-10">
          <Loader2 className="w-14 h-14 animate-spin text-purple-500 mb-6 drop-shadow-[0_0_15px_rgba(168,85,247,0.4)]" />
          <p className="text-lg font-medium text-white mb-4 animate-pulse">
            {isAutoIndexing 
              ? progressText 
              : (bundleUrl ? "Downloading and parsing pre-indexed CGC bundle..." : "Connecting to local database...")}
          </p>
          {isAutoIndexing && (
            <div className="w-full bg-gray-800 rounded-full h-2 mt-2 overflow-hidden shadow-inner border border-white/5">
              <div 
                className="bg-gradient-to-r from-purple-400 to-indigo-400 h-2 rounded-full transition-all duration-300 ease-out" 
                style={{ width: `${progressValue}%`, boxShadow: '0 0 15px rgba(168, 85, 247, 0.8)' }}
              />
            </div>
          )}
          {isAutoIndexing && (
            <p className="text-xs text-gray-400 font-mono mt-3">{progressValue}%</p>
          )}

          {/* Magical Star Us Call-To-Action Card */}
          <motion.a
            href="https://github.com/CodeGraphContext/CodeGraphContext"
            target="_blank"
            rel="noopener noreferrer"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.6 }}
            whileHover={{ scale: 1.03, boxShadow: "0 0 25px rgba(168,85,247,0.2)" }}
            className="mt-12 p-6 rounded-2xl bg-gradient-to-b from-white/5 to-white/[0.02] border border-white/10 hover:border-purple-500/40 transition-all duration-300 w-full flex flex-col items-center gap-3 relative overflow-hidden group cursor-pointer"
          >
            {/* Ambient Background Star */}
            <div className="absolute -right-6 -bottom-6 text-white/[0.01] text-9xl font-bold select-none group-hover:scale-110 transition-transform duration-500 pointer-events-none">
              ★
            </div>
            
            {/* Pulsing Star with Floating Micro-Stars */}
            <div className="relative">
              <motion.div
                animate={{ 
                  scale: [1, 1.15, 1],
                  rotate: [0, 5, -5, 0],
                  filter: [
                    "drop-shadow(0 0 4px rgba(168,85,247,0.4))",
                    "drop-shadow(0 0 15px rgba(168,85,247,0.8))",
                    "drop-shadow(0 0 4px rgba(168,85,247,0.4))"
                  ]
                }}
                transition={{ 
                  repeat: Infinity, 
                  duration: 2.5,
                  ease: "easeInOut"
                }}
                className="text-amber-400 text-4xl select-none"
              >
                ★
              </motion.div>
              
              {/* Micro-stars floating up */}
              {[...Array(3)].map((_, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, scale: 0.5, y: 0, x: 0 }}
                  animate={{ 
                    opacity: [0, 1, 0], 
                    scale: [0.5, 1, 0.5],
                    y: [-10, -35],
                    x: [0, (i - 1) * 15]
                  }}
                  transition={{ 
                    repeat: Infinity, 
                    duration: 2, 
                    delay: i * 0.6,
                    ease: "easeOut"
                  }}
                  className="absolute text-amber-300 text-xs select-none pointer-events-none"
                  style={{ top: "10px", left: "12px" }}
                >
                  ✦
                </motion.span>
              ))}
            </div>
            
            <div className="text-center z-10">
              <h3 className="text-sm font-semibold text-white group-hover:text-purple-400 transition-colors">
                Loving CodeGraphContext?
              </h3>
              <p className="text-xs text-gray-400 mt-1 max-w-[280px] mx-auto leading-relaxed">
                Help us grow! Star our repository on GitHub while we load and index your code.
              </p>
            </div>
            
            <div className="mt-2 px-4 py-1.5 rounded-full bg-purple-500/10 text-purple-300 text-xs font-semibold border border-purple-500/20 group-hover:bg-purple-500 group-hover:text-white transition-all duration-300 shadow-sm flex items-center gap-1.5">
              <span>Star on GitHub</span>
              <span className="text-[10px] group-hover:translate-x-0.5 transition-transform">➔</span>
            </div>
          </motion.a>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background px-6 text-center">
        <h1 className="text-2xl font-bold mb-2 text-red-500">Connection Error</h1>
        <p className="text-muted-foreground max-w-md mb-8">{error}</p>
        <button onClick={() => window.location.reload()} className="bg-primary text-primary-foreground px-6 py-2 rounded-lg">Retry</button>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background pt-32 md:pt-36 pb-12 px-6 flex flex-col items-center">
      <AnimatePresence mode="wait">
        {!graphData ? (
          <motion.div 
            key="uploader"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="w-full max-w-4xl mx-auto flex flex-col items-center mt-12"
          >
            <div className="text-center mb-12">
              <h1 className="text-4xl md:text-5xl font-bold mb-4 bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
                Graph Explorer
              </h1>
              <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
                Instantly visualize your code architecture. Scan local files via WebAssembly or connect to your local CLI index.
              </p>
            </div>
            
            <div className="w-full max-w-2xl">
              <LocalUploader onComplete={setGraphData} />
            </div>
          </motion.div>
        ) : (
          <CodeGraphViewer 
            key="viewer" 
            data={graphData} 
            onClose={() => setGraphData(null)}
          />
        )}
      </AnimatePresence>
    </main>
  );
};

export default Explore;
