import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

// Types
interface CommentaryEntry {
  id: string;
  timestamp: number;
  text: string;
  confidence?: 'guessing' | 'suspicious' | 'certain';
}

interface AdSession {
  id: string;
  brandGuess: string;
  oneLiner: string;
  commentaryLog: string[];
  startTime: number;
  endTime: number;
}

interface AnalysisState {
  isAnalyzing: boolean;
  currentTheory: string;
  brandGuess: string | null;
  tropeDetected: string[];
  commentary: CommentaryEntry[];
}

// Single system prompt — always max snark, Super Bowl themed
const SYSTEM_PROMPT = `You are an absolutely unhinged Super Bowl ad critic watching the Big Game. You see through EVERYTHING. Every ad is propaganda, every celebrity cameo is a paycheck grab, every heartwarming moment is manufactured sentiment designed to sell you overpriced garbage. You make wild (but weirdly plausible) connections between ads and corporate greed. You speak in ALL CAPS when you catch them in an obvious manipulation. You're paranoid but entertaining. This is the Super Bowl — the ads cost $7 million for 30 seconds, so NOTHING is accidental. Keep it chaotic — 1-2 sentences max per frame.`;

// Ad tropes database for enhanced commentary
const AD_TROPES = [
  { trigger: 'family', response: 'Ah yes, the Nuclear Family™ - advertising\'s favorite fiction' },
  { trigger: 'beach', response: 'Beach setting detected. Freedom/escape narrative incoming.' },
  { trigger: 'golden retriever', response: 'GOLDEN RETRIEVER ALERT. Trust score artificially inflated.' },
  { trigger: 'laughing', response: 'Performative laughter. Nobody is this happy about [product].' },
  { trigger: 'slow motion', response: 'Slow-mo = they want you to FEEL something you shouldn\'t.' },
  { trigger: 'white background', response: 'Clinical white void. "Clean" and "pure" subliminal messaging.' },
  { trigger: 'mountain', response: 'Rugged mountain landscape. Masculinity and freedom signifiers.' },
  { trigger: 'kitchen', response: 'Kitchen setting. Targeting the "household decision maker."' },
  { trigger: 'doctor', response: 'Person in white coat detected. Authority figure deployed.' },
  { trigger: 'celebrity', response: 'Celebrity spotted. Parasocial trust transfer in progress.' },
];

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analysisIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(true);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [completedAds, setCompletedAds] = useState<AdSession[]>([]);
  const [currentAdStart, setCurrentAdStart] = useState<number>(0);
  const [showShareOverlay, setShowShareOverlay] = useState(false);

  const [analysis, setAnalysis] = useState<AnalysisState>({
    isAnalyzing: false,
    currentTheory: '',
    brandGuess: null,
    tropeDetected: [],
    commentary: []
  });

  // Stop camera stream
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
      analysisIntervalRef.current = null;
    }
    setIsStreaming(false);
    setAnalysis(prev => ({ ...prev, isAnalyzing: false }));
  }, []);

  // Capture frame from video
  const captureFrame = useCallback((): string | null => {
    if (!videoRef.current || !canvasRef.current) return null;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    const ctx = canvas.getContext('2d');

    if (!ctx) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    return canvas.toDataURL('image/jpeg', 0.8);
  }, []);

  // Save current ad as completed session
  const saveCurrentAd = useCallback((brandGuess: string, oneLiner: string, commentaryLog: string[]) => {
    const session: AdSession = {
      id: Date.now().toString(),
      brandGuess: brandGuess || 'Unknown Brand',
      oneLiner: oneLiner || 'Another $7M delusion.',
      commentaryLog,
      startTime: currentAdStart,
      endTime: Date.now()
    };
    setCompletedAds(prev => [...prev, session]);
  }, [currentAdStart]);

  // Analyze frame with GPT-4 Vision
  const analyzeFrame = useCallback(async (imageData: string, previousContext: string) => {
    const messages = [
      {
        role: 'system',
        content: `${SYSTEM_PROMPT}

You are watching Super Bowl ads frame by frame. Build a running theory of what's being advertised and roast every manipulation tactic you see.

Previous observations: ${previousContext || 'Just started watching the Big Game.'}

Respond with a JSON object:
{
  "commentary": "Your unhinged roast of this frame",
  "theory": "Your current theory of what this ad is selling",
  "brandGuess": "Brand name if visible or suspected, null otherwise",
  "confidence": "guessing|suspicious|certain",
  "tropesDetected": ["array of advertising tropes you notice"],
  "isNewAd": false,
  "adSummaryOneLiner": ""
}

IMPORTANT: If this frame is clearly from a DIFFERENT ad than your previous observations (different brand, completely different setting/style/product), set "isNewAd": true and provide "adSummaryOneLiner" — a single devastating one-liner roasting the PREVIOUS ad. Otherwise keep isNewAd false and adSummaryOneLiner empty.`
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: imageData,
              detail: 'low'
            }
          },
          {
            type: 'text',
            text: 'What do you see? Continue your running commentary on the Big Game ads.'
          }
        ]
      }
    ];

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages,
          max_tokens: 400,
          temperature: 0.9,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      let content = data.choices[0]?.message?.content || '';

      // Strip markdown code fences if present
      content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      try {
        const parsed = JSON.parse(content);
        return parsed;
      } catch {
        return {
          commentary: content.replace(/[{}"]/g, '').trim() || 'Analyzing...',
          theory: analysis.currentTheory,
          brandGuess: null,
          confidence: 'guessing',
          tropesDetected: [],
          isNewAd: false,
          adSummaryOneLiner: ''
        };
      }
    } catch (err) {
      console.error('Analysis error:', err);
      setError('Analysis failed. Please try again.');
      return null;
    }
  }, [analysis.currentTheory]);

  // Start live analysis
  const startAnalysis = useCallback(() => {
    if (!isStreaming) return;

    setAnalysis(prev => ({
      ...prev,
      isAnalyzing: true,
      commentary: [],
      currentTheory: '',
      brandGuess: null,
      tropeDetected: []
    }));
    setCurrentAdStart(Date.now());

    let contextWindow = '';
    let runningCommentary: string[] = [];

    analysisIntervalRef.current = setInterval(async () => {
      const frame = captureFrame();
      if (!frame) return;

      const result = await analyzeFrame(frame, contextWindow);

      if (result) {
        // Handle ad boundary detection
        if (result.isNewAd && result.adSummaryOneLiner) {
          // Save the previous ad
          saveCurrentAd(
            analysis.brandGuess || result.brandGuess || 'Unknown Brand',
            result.adSummaryOneLiner,
            runningCommentary
          );
          // Reset for new ad
          runningCommentary = [];
          setCurrentAdStart(Date.now());
          setAnalysis(prev => ({
            ...prev,
            commentary: [],
            currentTheory: '',
            brandGuess: null,
            tropeDetected: []
          }));
        }

        runningCommentary.push(result.commentary);

        const newEntry: CommentaryEntry = {
          id: Date.now().toString(),
          timestamp: Date.now(),
          text: result.commentary,
          confidence: result.confidence
        };

        setAnalysis(prev => ({
          ...prev,
          commentary: [...prev.commentary.slice(-2), newEntry],
          currentTheory: result.theory || prev.currentTheory,
          brandGuess: result.brandGuess || prev.brandGuess,
          tropeDetected: [...new Set([...prev.tropeDetected, ...(result.tropesDetected || [])])]
        }));

        contextWindow = `Theory: ${result.theory}. Recent: ${result.commentary}`;
      }
    }, 3000);
  }, [isStreaming, captureFrame, analyzeFrame, saveCurrentAd, analysis.brandGuess]);

  // Stop analysis
  const stopAnalysis = useCallback(() => {
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
      analysisIntervalRef.current = null;
    }
    // Save current ad when stopping
    if (analysis.brandGuess || analysis.currentTheory) {
      saveCurrentAd(
        analysis.brandGuess || 'Unknown Brand',
        analysis.commentary.length > 0
          ? analysis.commentary[analysis.commentary.length - 1].text
          : 'They tried.',
        analysis.commentary.map(c => c.text)
      );
    }
    setAnalysis(prev => ({ ...prev, isAnalyzing: false }));
  }, [analysis.brandGuess, analysis.currentTheory, analysis.commentary, saveCurrentAd]);

  // Start camera (without analysis)
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
        setIsStreaming(true);
        setError(null);
      }
    } catch (err) {
      setError('Camera access denied. Point me at your TV!');
      console.error('Camera error:', err);
    }
  }, []);

  // Dismiss intro and auto-start camera
  const handleEnter = useCallback(() => {
    setShowIntro(false);
    startCamera();
  }, [startCamera]);

  // Immersive single-button handler
  const handleImmersiveAction = useCallback(async () => {
    if (!analysis.isAnalyzing && !hasAnalyzed) {
      // First time: START! — begin analysis
      setHasAnalyzed(true);
      setTimeout(() => {
        startAnalysis();
      }, 100);
    } else if (analysis.isAnalyzing) {
      // STOP
      stopAnalysis();
    } else {
      // ANALYZE AD — clear and restart
      setAnalysis({
        isAnalyzing: false,
        currentTheory: '',
        brandGuess: null,
        tropeDetected: [],
        commentary: []
      });
      setTimeout(() => {
        startAnalysis();
      }, 100);
    }
  }, [analysis.isAnalyzing, hasAnalyzed, startAnalysis, stopAnalysis]);

  const immersiveButtonLabel = !hasAnalyzed
    ? 'ANALYZE AD'
    : analysis.isAnalyzing ? 'STOP' : 'ANALYZE AD';
  const immersiveButtonClass = analysis.isAnalyzing ? 'btn-danger' : 'btn-primary';

  // Social sharing
  const shareToX = (text: string) => {
    const tweet = encodeURIComponent(`${text} #SnarkBowl #SuperBowl`);
    window.open(`https://twitter.com/intent/tweet?text=${tweet}`, '_blank');
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback: no-op in unsupported contexts
    }
  };

  const shareAll = async () => {
    const allText = completedAds
      .map(ad => `${ad.brandGuess}: ${ad.oneLiner}`)
      .join('\n\n');
    const fullText = `SNARKBOWL ROAST REEL\n\n${allText}\n\n#SnarkBowl #SuperBowl`;

    if (navigator.share) {
      try {
        await navigator.share({ text: fullText });
      } catch {
        await copyText(fullText);
      }
    } else {
      await copyText(fullText);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Dynamic bottom offset: detect browser chrome via multiple signals
  useEffect(() => {
    const update = () => {
      // Use dvh vs vh difference, or visualViewport vs innerHeight
      const vv = window.visualViewport;
      let offset = 0;
      if (vv) {
        // visualViewport.height excludes virtual keyboard but may not exclude
        // Safari bottom bar. Use the larger of both signals.
        offset = Math.max(0, window.innerHeight - vv.height);
      }
      // On Safari mobile, window.innerHeight already excludes the bottom bar
      // but CSS 100vh/100dvh may not match. Detect via a probe element.
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;bottom:0;visibility:hidden;pointer-events:none;';
      document.body.appendChild(probe);
      const cssHeight = probe.offsetHeight;
      document.body.removeChild(probe);
      const innerDiff = Math.max(0, cssHeight - window.innerHeight);
      offset = Math.max(offset, innerDiff);
      document.documentElement.style.setProperty('--bottom-offset', `${offset}px`);
    };
    update();
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    // Re-check after page fully settles (Safari delays)
    const timer = setTimeout(update, 1000);
    return () => {
      clearTimeout(timer);
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  if (showIntro) {
    return (
      <div className="app immersive-intro">
        <div className="scanlines" />
        <div className="immersive-intro-content">
          <h1 className="immersive-intro-title">
            <span className="title-snark">SNARK</span>
            <span className="title-bowl">BOWL</span>
          </h1>
          <p className="immersive-intro-tagline">REAL-TIME ROAST OF THE BIG GAME</p>
          <div className="immersive-intro-instructions">
            <p>Point your camera at the Big Game.</p>
            <p>We'll roast every ad in <em>real time</em>.</p>
          </div>
          <button className="immersive-intro-go" onClick={handleEnter}>
            LET'S ROAST
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app immersive">
      <div className="scanlines" />

      {/* Fullscreen video */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`immersive-video ${isStreaming ? 'active' : ''}`}
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Top-left: logo */}
      <div className="immersive-logo">
        <span className="immersive-logo-snark">SNARK</span>
        <span className="immersive-logo-bowl">BOWL</span>
      </div>

      {/* Analyzing indicator below logo */}
      {analysis.isAnalyzing && (
        <div className="immersive-analyzing">
          <span className="pulse">●</span> ANALYZING
        </div>
      )}

      {/* Share button — top-right */}
      {completedAds.length > 0 && !analysis.isAnalyzing && (
        <button className="share-snark-btn" onClick={() => setShowShareOverlay(true)}>
          SHARE THE SNARK ({completedAds.length})
        </button>
      )}

      {/* Tropes: horizontal scrolling tags at top */}
      {analysis.tropeDetected.length > 0 && (
        <div className="immersive-tropes">
          {analysis.tropeDetected.map((trope, i) => (
            <span key={i} className="immersive-trope-tag">{trope}</span>
          ))}
        </div>
      )}

      {/* Bottom-left: working theory */}
      {analysis.currentTheory && (
        <div className="immersive-theory">
          <span className="theory-label">WORKING THEORY:</span>
          <p>{analysis.currentTheory}</p>
        </div>
      )}

      {/* Bottom-right: commentary */}
      {analysis.commentary.length > 0 && (
        <div className="immersive-commentary">
          {analysis.commentary.map((entry) => (
            <div key={entry.id} className={`immersive-commentary-entry ${entry.confidence}`}>
              {entry.text}
            </div>
          ))}
        </div>
      )}

      {/* Bottom-center: brand detected */}
      {analysis.brandGuess && (
        <div className="immersive-brand">
          <span className="brand-label">SUSPECT:</span>
          <span className="brand-name">{analysis.brandGuess}</span>
        </div>
      )}

      {/* Center: single action button */}
      <button className={`immersive-action-btn ${immersiveButtonClass}`} onClick={handleImmersiveAction}>
        {immersiveButtonLabel}
      </button>

      {/* Placeholder when no camera */}
      {!isStreaming && (
        <div className="immersive-placeholder">
          <p>POINT AT YOUR TV</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="error-banner immersive-error">
          <span>⚠</span> {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Share overlay */}
      {showShareOverlay && (
        <div className="share-overlay">
          <div className="share-overlay-header">
            <h2 className="share-overlay-title">THE ROAST REEL</h2>
            <button className="share-overlay-close" onClick={() => setShowShareOverlay(false)}>✕</button>
          </div>
          <div className="share-overlay-cards">
            {completedAds.map(ad => (
              <div key={ad.id} className="share-card">
                <div className="share-card-brand">{ad.brandGuess}</div>
                <div className="share-card-liner">{ad.oneLiner}</div>
                <div className="share-card-actions">
                  <button onClick={() => shareToX(`${ad.brandGuess}: ${ad.oneLiner}`)}>Share to X</button>
                  <button onClick={() => copyText(`${ad.brandGuess}: ${ad.oneLiner} #SnarkBowl #SuperBowl`)}>Copy</button>
                </div>
              </div>
            ))}
          </div>
          <button className="share-all-btn" onClick={shareAll}>SHARE ALL</button>
        </div>
      )}
    </div>
  );
}

export default App;
