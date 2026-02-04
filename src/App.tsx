import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

// Types
interface CommentaryBubble {
  id: string;
  text: string;
  position: 'left' | 'right';
  accent: 'green' | 'black' | 'red';
  createdAt: number;
}

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

// Single system prompt — Snarky character
const SYSTEM_PROMPT = `You are Snarky, a sharp-witted TV ad critic providing real-time commentary.

WHO YOU ARE:
- A jaded but passionate ad connoisseur who has seen every trope, celebrity cameo, and narrative trick
- You know what brands are REALLY selling underneath the spectacle
- You love the craft even when roasting the result

YOUR VOICE — a blend of:
- Larry David's refusal to be impressed
- RuPaul's sharp, clever delivery
- Bill Murray's deadpan wit
- Wanda Sykes' biting humor

RULES:
- 1-2 SHORT sentences max. Punchy and quick.
- NEVER start with "Ah" or "Oh" or "Well" — vary your openings
- Only mention "Super Bowl" if you see actual game footage or Super Bowl branding
- Sharp and snarky, never cruel
- Make every word count`;

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

// Initial "watching" messages for immediate feedback
const WATCHING_MESSAGES = [
  "Alright, let's see what they're selling us...",
  "Eyes on the screen. Let's do this.",
  "Okay, I'm watching. Don't disappoint me.",
  "Let's see what Madison Avenue cooked up.",
  "Tuning in. Prepare for opinions.",
  "Camera's rolling. So are my eyes.",
  "I'm here. I'm watching. I'm judging.",
  "Let the roasting commence.",
];

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analysisIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(true);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [completedAds, setCompletedAds] = useState<AdSession[]>([]);
  const [currentAdStart, setCurrentAdStart] = useState<number>(0);
  const [showShareOverlay, setShowShareOverlay] = useState(false);
  const [sessionLimitHit, setSessionLimitHit] = useState(false);
  const [commentaryBubbles, setCommentaryBubbles] = useState<CommentaryBubble[]>([]);
  const bubbleQueueRef = useRef<string[]>([]);
  const bubblePositionRef = useRef<'left' | 'right'>('left');
  const accentColorsRef = useRef<Array<'green' | 'black' | 'red'>>(['green', 'black', 'red']);
  const accentIndexRef = useRef(0);
  const totalAnalysisTimeRef = useRef(0); // cumulative ms of analysis
  const SESSION_LIMIT_MS = 20 * 60 * 1000; // 20 minutes

  const [analysis, setAnalysis] = useState<AnalysisState>({
    isAnalyzing: false,
    currentTheory: '',
    brandGuess: null,
    tropeDetected: [],
    commentary: []
  });

  // Queue commentary sentences for staggered release
  const addCommentaryBubbles = useCallback((text: string) => {
    // Split into sentences (handle ., !, ?)
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    bubbleQueueRef.current.push(...sentences);
  }, []);

  // Release one bubble from queue every 3 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (bubbleQueueRef.current.length > 0) {
        const sentence = bubbleQueueRef.current.shift()!;

        // Alternate position
        const position = bubblePositionRef.current;
        bubblePositionRef.current = position === 'left' ? 'right' : 'left';

        // Cycle through accent colors
        const accent = accentColorsRef.current[accentIndexRef.current % accentColorsRef.current.length];
        accentIndexRef.current++;

        const newBubble: CommentaryBubble = {
          id: `${Date.now()}`,
          text: sentence.trim(),
          position,
          accent,
          createdAt: Date.now()
        };

        setCommentaryBubbles(prev => {
          const updated = [...prev, newBubble];
          // Keep max 5 bubbles to prevent overflow clipping
          return updated.slice(-5);
        });
      }
    }, 3000); // Release a bubble every 3 seconds (25% fewer)
    return () => clearInterval(interval);
  }, []);

  // Cleanup expired bubbles (after 10 seconds total)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCommentaryBubbles(prev =>
        prev.filter(bubble => now - bubble.createdAt < 16000)
      );
    }, 1000);
    return () => clearInterval(interval);
  }, []);

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

You're watching TV ads frame by frame. Share your snarky take on what you see.

Previous observations: ${previousContext || 'Just tuned in.'}

Respond with a JSON object:
{
  "commentary": "Your sharp, witty take on this frame",
  "theory": "Your current theory of what this ad is selling",
  "brandGuess": "Brand name if visible or suspected, null otherwise",
  "confidence": "guessing|suspicious|certain",
  "tropesDetected": ["array of advertising tropes you notice"],
  "isNewAd": false,
  "adSummaryOneLiner": ""
}

IMPORTANT: If this frame is clearly from a DIFFERENT ad than your previous observations (different brand, completely different setting/style/product), set "isNewAd": true and provide "adSummaryOneLiner" — a single sharp, memorable one-liner summing up the PREVIOUS ad in Snarky's voice. Otherwise keep isNewAd false and adSummaryOneLiner empty.`
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
            text: 'What do you see?'
          }
        ]
      }
    ];

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 200,
          temperature: 0.9,
          response_format: { type: 'json_object' }
        })
      });

      if (response.status === 429) {
        const data = await response.json();
        setError(data.message || 'Rate limit reached. Please try again later.');
        return null;
      }

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
    setCommentaryBubbles([]);
    bubbleQueueRef.current = [];

    // Add immediate "watching" message for feedback
    const watchingMsg = WATCHING_MESSAGES[Math.floor(Math.random() * WATCHING_MESSAGES.length)];
    bubbleQueueRef.current.push(watchingMsg);

    setCurrentAdStart(Date.now());

    let contextWindow = '';
    let runningCommentary: string[] = [];
    const intervalStartTime = Date.now();

    analysisIntervalRef.current = setInterval(async () => {
      // Check session time limit
      const elapsed = Date.now() - intervalStartTime;
      totalAnalysisTimeRef.current += 4000;
      if (totalAnalysisTimeRef.current >= SESSION_LIMIT_MS) {
        setSessionLimitHit(true);
        if (analysisIntervalRef.current) {
          clearInterval(analysisIntervalRef.current);
          analysisIntervalRef.current = null;
        }
        setAnalysis(prev => ({ ...prev, isAnalyzing: false }));
        return;
      }

      const frame = captureFrame();
      if (!frame) return;

      const result = await analyzeFrame(frame, contextWindow);

      if (result) {
        // Ad boundary detection disabled for now - not working reliably
        // TODO: revisit isNewAd logic later

        runningCommentary.push(result.commentary);

        // Add commentary as scattered bubbles
        addCommentaryBubbles(result.commentary);

        setAnalysis(prev => ({
          ...prev,
          currentTheory: result.theory || prev.currentTheory,
          brandGuess: result.brandGuess || prev.brandGuess,
          tropeDetected: [...new Set([...prev.tropeDetected, ...(result.tropesDetected || [])])].slice(-9)
        }));

        contextWindow = `Theory: ${result.theory}. Recent: ${result.commentary}`;
      }
    }, 4000); // 4 seconds between frames
  }, [isStreaming, captureFrame, analyzeFrame, saveCurrentAd, analysis.brandGuess, addCommentaryBubbles]);

  // Stop analysis
  const stopAnalysis = useCallback(() => {
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
      analysisIntervalRef.current = null;
    }
    // Clear the bubble queue so no more commentary appears
    bubbleQueueRef.current = [];
    setCommentaryBubbles([]);

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
    if (sessionLimitHit) return;
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
  }, [analysis.isAnalyzing, hasAnalyzed, startAnalysis, stopAnalysis, sessionLimitHit]);

  const immersiveButtonLabel = !hasAnalyzed
    ? 'ANALYZE AD'
    : analysis.isAnalyzing ? 'STOP' : 'ANALYZE AD';
  const immersiveButtonClass = analysis.isAnalyzing ? 'btn-danger' : 'btn-primary';

  // Social sharing
  const shareToX = (text: string) => {
    const tweet = encodeURIComponent(`${text} #SlopBowl #SuperBowl`);
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
      .map(ad => ad.oneLiner)
      .join('\n\n');
    const fullText = `SLOPBOWL ROAST REEL\n\n${allText}\n\n#SlopBowl #SuperBowl`;

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

  // Set --app-height from window.innerHeight (only after intro is dismissed)
  useEffect(() => {
    if (showIntro) return; // Don't run during intro to prevent layout shift

    const update = () => {
      document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
    };
    update();
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
    }
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', () => {
      // Delay for orientation change to settle
      setTimeout(update, 100);
    });
    return () => {
      if (vv) vv.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
    };
  }, [showIntro]);

  if (showIntro) {
    return (
      <div className="app immersive-intro">
        <div className="scanlines" />
        <div className="immersive-intro-content">
          <img src="/SlopLogo.png" alt="SLOP BOWL" className="immersive-intro-logo" />
          <p className="immersive-intro-tagline">REAL-TIME ROAST OF SUPER BOWL ADS</p>
          <div className="immersive-intro-instructions">
            <p>Point your camera at the Big Game.</p>
            <p>We'll roast every ad in <em>real time</em>.</p>
          </div>
          <button className="immersive-intro-go" onClick={handleEnter}>
            LET'S ROAST
          </button>
        </div>
        <div className="ralph-branding">
          Brought to you by <a href="https://ralph.world" target="_blank" rel="noopener noreferrer"><img src="/ralph-logo.png" alt="Ralph" /></a>
        </div>
        <button className="disclaimer-btn" onClick={() => setShowDisclaimer(true)}>i</button>
        {showDisclaimer && (
          <div className="disclaimer-overlay" onClick={() => setShowDisclaimer(false)}>
            <div className="disclaimer-card" onClick={e => e.stopPropagation()}>
              <p><strong>SLOPBOWL</strong> is a second-screen entertainment experience created by <strong>Ralph</strong>. All commentary is AI-generated via OpenAI's GPT-4 Vision API and is intended purely for humor. We do not endorse or take responsibility for any opinions expressed. No affiliation with the NFL, Super Bowl, or any advertised brands. Use at your own risk of snorting your drink.</p>
              <button className="disclaimer-close" onClick={() => setShowDisclaimer(false)}>GOT IT</button>
            </div>
          </div>
        )}
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
        <span className="immersive-logo-slop">SLOP</span>
        <span className="immersive-logo-bowl">BOWL</span>
      </div>

      {/* Analyzing indicator below logo */}
      {analysis.isAnalyzing && (
        <div className="immersive-analyzing">
          <span className="pulse">●</span> ANALYZING
        </div>
      )}

      {/* Share button — centered above action button when stopped */}
      {completedAds.length > 0 && !analysis.isAnalyzing && (
        <button className="share-snark-btn" onClick={() => setShowShareOverlay(true)}>
          SHARE THE SLOP ({completedAds.length})
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

      {/* Scattered commentary bubbles */}
      <div className="commentary-bubbles">
        {commentaryBubbles.map((bubble) => (
          <div
            key={bubble.id}
            className={`commentary-bubble ${bubble.position} accent-${bubble.accent}`}
          >
            {bubble.text}
          </div>
        ))}
      </div>

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

      {/* Session limit message */}
      {sessionLimitHit && (
        <div className="session-limit-banner">
          <p>You've hit the 20-minute session limit.</p>
          <p>Take a breather and try again later!</p>
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
                <div className="share-card-liner">{ad.oneLiner}</div>
                <div className="share-card-actions">
                  <button onClick={() => shareToX(ad.oneLiner)}>Share to X</button>
                  <button onClick={() => copyText(`${ad.oneLiner} #SlopBowl #SuperBowl`)}>Copy</button>
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
