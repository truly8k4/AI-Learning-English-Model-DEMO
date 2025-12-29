import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionState, Scenario, TranscriptItem } from './types';
import { SCENARIOS, AUDIO_SAMPLE_RATE } from './constants';
import { Visualizer } from './components/Visualizer';
import { base64ToUint8Array, createPcmBlob, decodeAudioData } from './utils/audio';

// Icons
const MicIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
);
const MicOffIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
);
const PhoneOffIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>
);
const MessageIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
);

export default function App() {
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  
  // Refs for audio context and processing
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  
  // Playback queue management
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Transcription buffer
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  const [activeInputAnalyser, setActiveInputAnalyser] = useState<AnalyserNode | null>(null);
  const [activeOutputAnalyser, setActiveOutputAnalyser] = useState<AnalyserNode | null>(null);

  // cleanup function
  const stopSession = useCallback(async () => {
    // Disconnect Media sources
    if (inputSourceRef.current) {
      inputSourceRef.current.disconnect();
      inputSourceRef.current.mediaStream.getTracks().forEach(track => track.stop());
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
    }
    
    // Stop all playing audio
    for (const source of audioSourcesRef.current) {
      try { source.stop(); } catch (e) { /* ignore already stopped */ }
    }
    audioSourcesRef.current.clear();
    
    // Close Audio Contexts
    if (inputAudioContextRef.current?.state !== 'closed') {
      await inputAudioContextRef.current?.close();
    }
    if (outputAudioContextRef.current?.state !== 'closed') {
      await outputAudioContextRef.current?.close();
    }

    setConnectionState(ConnectionState.DISCONNECTED);
    setActiveInputAnalyser(null);
    setActiveOutputAnalyser(null);
    // Note: We cannot strictly "close" the Gemini Live session from the client side object 
    // unless we keep a reference to a close method if the SDK exposes one, 
    // but typically dropping the reference and closing WebSocket (handled by SDK) works.
    // The Live API via `@google/genai` manages the WS connection.
    // We will just reset UI state here.
  }, []);

  const startSession = async (scenario: Scenario) => {
    try {
      setConnectionState(ConnectionState.CONNECTING);
      setTranscript([]);
      currentInputTranscription.current = '';
      currentOutputTranscription.current = '';

      // Initialize Audio Contexts
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContextClass({ sampleRate: AUDIO_SAMPLE_RATE });

      // Input Setup (Mic)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      inputSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(stream);
      inputAnalyserRef.current = inputAudioContextRef.current.createAnalyser();
      processorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      inputSourceRef.current.connect(inputAnalyserRef.current);
      inputSourceRef.current.connect(processorRef.current);
      processorRef.current.connect(inputAudioContextRef.current.destination); // Need this for script processor to run
      
      setActiveInputAnalyser(inputAnalyserRef.current);

      // Output Setup (Speaker)
      outputNodeRef.current = outputAudioContextRef.current.createGain();
      outputAnalyserRef.current = outputAudioContextRef.current.createAnalyser();
      outputNodeRef.current.connect(outputAnalyserRef.current);
      outputAnalyserRef.current.connect(outputAudioContextRef.current.destination);
      
      setActiveOutputAnalyser(outputAnalyserRef.current);

      nextStartTimeRef.current = outputAudioContextRef.current.currentTime;

      // Initialize Gemini
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // Connect to Live API
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: scenario.systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
          },
          inputAudioTranscription: { },
          outputAudioTranscription: { }
        },
        callbacks: {
          onopen: () => {
            console.log('Session opened');
            setConnectionState(ConnectionState.CONNECTED);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current && outputNodeRef.current) {
               const ctx = outputAudioContextRef.current;
               try {
                 const uint8Array = base64ToUint8Array(base64Audio);
                 const audioBuffer = await decodeAudioData(uint8Array, ctx);
                 
                 // Schedule playback
                 nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                 
                 const source = ctx.createBufferSource();
                 source.buffer = audioBuffer;
                 source.connect(outputNodeRef.current);
                 
                 source.start(nextStartTimeRef.current);
                 nextStartTimeRef.current += audioBuffer.duration;
                 
                 audioSourcesRef.current.add(source);
                 source.onended = () => audioSourcesRef.current.delete(source);
               } catch (err) {
                 console.error("Error decoding audio", err);
               }
            }

            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              console.log("Interrupted!");
              // Stop all currently playing sources immediately
              for (const source of audioSourcesRef.current) {
                source.stop();
              }
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = outputAudioContextRef.current?.currentTime || 0;
            }

            // Handle Transcription
            // 1. Output (Model)
            const outputText = message.serverContent?.outputTranscription?.text;
            if (outputText) {
              currentOutputTranscription.current += outputText;
            }
            
            // 2. Input (User)
            const inputText = message.serverContent?.inputTranscription?.text;
            if (inputText) {
              currentInputTranscription.current += inputText;
            }

            // 3. Turn Complete - Commit transcripts
            if (message.serverContent?.turnComplete) {
              const newItems: TranscriptItem[] = [];
              if (currentInputTranscription.current.trim()) {
                newItems.push({
                  id: Date.now().toString() + '-user',
                  speaker: 'user',
                  text: currentInputTranscription.current.trim(),
                  timestamp: new Date()
                });
                currentInputTranscription.current = '';
              }
              if (currentOutputTranscription.current.trim()) {
                newItems.push({
                  id: Date.now().toString() + '-model',
                  speaker: 'model',
                  text: currentOutputTranscription.current.trim(),
                  timestamp: new Date()
                });
                currentOutputTranscription.current = '';
              }

              if (newItems.length > 0) {
                setTranscript(prev => [...prev, ...newItems]);
              }
            }
          },
          onclose: () => {
            console.log('Session closed');
            setConnectionState(ConnectionState.DISCONNECTED);
          },
          onerror: (e) => {
            console.error('Session error', e);
            setConnectionState(ConnectionState.ERROR);
          }
        }
      });

      // Hook up audio processor to send data
      if (processorRef.current) {
        processorRef.current.onaudioprocess = (e) => {
          if (isMuted) return; // Don't send data if muted

          const inputData = e.inputBuffer.getChannelData(0);
          const blob = createPcmBlob(inputData);
          
          sessionPromise.then(session => {
             session.sendRealtimeInput({ media: blob });
          });
        };
      }

    } catch (error) {
      console.error("Failed to start session:", error);
      setConnectionState(ConnectionState.ERROR);
    }
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  useEffect(scrollToBottom, [transcript]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 font-sans">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold">
              LF
            </div>
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-purple-600">
              LinguaFlow
            </h1>
          </div>
          <div className="text-sm text-gray-500 hidden sm:block">
            Gemini 2.5 Native Audio Demo
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
          /* Scenario Selection View */
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <h2 className="text-4xl font-extrabold text-gray-900 mb-4">
                Master English with Confidence
              </h2>
              <p className="text-lg text-gray-600 max-w-2xl mx-auto">
                Choose a real-world scenario and start a voice conversation with our AI tutor. 
                Practice speaking, listening, and get real-time feedback.
              </p>
              {connectionState === ConnectionState.ERROR && (
                <div className="mt-4 p-3 bg-red-50 text-red-700 rounded-md inline-block">
                  Connection failed. Please check your microphone permissions and try again.
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario.id}
                  onClick={() => {
                    setSelectedScenario(scenario);
                    startSession(scenario);
                  }}
                  className="group relative bg-white p-6 rounded-2xl shadow-sm hover:shadow-xl border border-gray-100 transition-all duration-300 text-left hover:-translate-y-1"
                >
                  <div className="absolute top-6 right-6 text-4xl opacity-20 group-hover:opacity-100 group-hover:scale-110 transition-all">
                    {scenario.emoji}
                  </div>
                  <div className="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 mb-4">
                    {scenario.difficulty}
                  </div>
                  <h3 className="text-xl font-bold text-gray-900 mb-2">{scenario.title}</h3>
                  <p className="text-gray-600">{scenario.description}</p>
                  <div className="mt-4 flex items-center text-indigo-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                    Start Session <span className="ml-2">→</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Live Session View */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-8rem)]">
            
            {/* Visualizer & Controls (Left/Center) */}
            <div className="lg:col-span-2 bg-white rounded-3xl shadow-lg border border-gray-100 flex flex-col relative overflow-hidden">
              <div className="absolute top-6 left-6 z-10">
                <div className="flex items-center gap-3 bg-white/80 backdrop-blur-sm px-4 py-2 rounded-full shadow-sm border border-gray-100">
                  <span className="text-2xl">{selectedScenario?.emoji}</span>
                  <div>
                    <h3 className="font-bold text-gray-900">{selectedScenario?.title}</h3>
                    <p className="text-xs text-gray-500 flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                      Live Session
                    </p>
                  </div>
                </div>
              </div>

              {/* Visualization Area */}
              <div className="flex-1 flex flex-col items-center justify-center relative bg-gradient-to-b from-gray-50 to-white">
                <div className="relative">
                  {/* Outer glow rings */}
                  <div className="absolute inset-0 bg-indigo-500/10 rounded-full blur-3xl animate-pulse transform scale-150"></div>
                  
                  {/* Main Visualizer */}
                  <div className="relative z-10 flex flex-col items-center gap-8">
                     {/* AI Visualizer */}
                     <div className="relative w-64 h-64 flex items-center justify-center">
                        <Visualizer analyser={activeOutputAnalyser} isActive={true} color="#4f46e5" />
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="w-32 h-32 bg-indigo-100 rounded-full flex items-center justify-center shadow-inner">
                                <div className="w-4 h-4 bg-indigo-500 rounded-full animate-bounce"></div>
                            </div>
                        </div>
                     </div>
                     
                     {/* User Mic Visualizer (smaller) */}
                     <div className="h-12 w-32">
                        {!isMuted && <Visualizer analyser={activeInputAnalyser} isActive={true} color="#10b981" />}
                        {isMuted && <div className="text-gray-400 text-sm font-medium">Microphone Muted</div>}
                     </div>
                  </div>
                </div>
              </div>

              {/* Controls Bar */}
              <div className="p-6 bg-white border-t border-gray-100 flex items-center justify-center gap-6">
                <button
                  onClick={toggleMute}
                  className={`p-4 rounded-full transition-all duration-200 ${
                    isMuted 
                    ? 'bg-red-100 text-red-600 hover:bg-red-200' 
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                  title={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? <MicOffIcon /> : <MicIcon />}
                </button>

                <button
                  onClick={stopSession}
                  className="px-8 py-4 bg-red-500 hover:bg-red-600 text-white rounded-full font-bold shadow-lg shadow-red-500/30 flex items-center gap-2 transition-all hover:scale-105 active:scale-95"
                >
                  <PhoneOffIcon />
                  <span>End Session</span>
                </button>
              </div>
            </div>

            {/* Transcript Panel (Right) */}
            <div className="bg-white rounded-3xl shadow-lg border border-gray-100 flex flex-col overflow-hidden h-full">
              <div className="p-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                  <MessageIcon /> Transcript
                </h3>
                <span className="text-xs text-gray-500">Auto-scroll on</span>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {transcript.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 text-sm text-center px-6">
                    <p>Conversation started...</p>
                    <p>Speak clearly to see the transcript here.</p>
                  </div>
                ) : (
                  transcript.map((item) => (
                    <div
                      key={item.id}
                      className={`flex flex-col ${item.speaker === 'user' ? 'items-end' : 'items-start'}`}
                    >
                      <div
                        className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                          item.speaker === 'user'
                            ? 'bg-indigo-600 text-white rounded-br-none'
                            : 'bg-gray-100 text-gray-800 rounded-bl-none'
                        }`}
                      >
                        {item.text}
                      </div>
                      <span className="text-[10px] text-gray-400 mt-1 px-1">
                        {item.speaker === 'user' ? 'You' : 'AI Tutor'}
                      </span>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}