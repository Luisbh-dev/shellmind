"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Bot, User, RotateCw, MoreHorizontal, Sparkles, Play, Zap } from "lucide-react";
import { clsx } from "clsx";
import ReactMarkdown from 'react-markdown';

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ChatProps {
  activeServer: any;
  terminalHistory?: React.MutableRefObject<string>;
}

const RECIPES = {}; // Moved to Terminal

export default function Chat({ activeServer, terminalHistory }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([
    { id: "1", role: "assistant", content: "ShellMind AI ready. Select a server to begin." }
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isAutoRun, setIsAutoRun] = useState(false);
  const [selectedModel, setSelectedModel] = useState("gemini-2.5-flash");
  
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Load preferred model
  useEffect(() => {
      fetch("http://localhost:3001/api/config/model")
        .then(res => res.json())
        .then(data => {
            if (data.model) setSelectedModel(data.model);
        })
        .catch(err => console.error("Failed to load model config", err));
  }, []);

  const handleModelChange = async (newModel: string) => {
      setSelectedModel(newModel);
      try {
          await fetch("http://localhost:3001/api/config/model", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: newModel })
          });
      } catch (e) {
          console.error("Failed to save model preference", e);
      }
  };

  const toggleAutoRun = () => {
      if (!isAutoRun) {
          if (confirm("⚠️ CAUTION: Auto-Run mode will execute commands suggested by the AI IMMEDIATELY.\n\nAre you sure you want to enable this?")) {
              setIsAutoRun(true);
          }
      } else {
          setIsAutoRun(false);
      }
  };

  // Reset chat when server changes
  useEffect(() => {
      setMessages([
          { 
              id: "init-" + (activeServer?.id || "default"), 
              role: "assistant", 
              content: activeServer 
                ? `ShellMind connected to **${activeServer.name}**. Ready to assist.`
                : "ShellMind AI ready. Select a server to begin."
          }
      ]);
  }, [activeServer?.id]);

  // Announce OS detection
  useEffect(() => {
      if (activeServer?.osDetail) {
          setMessages(prev => {
              // Prevent duplicate announcements if strict mode renders twice
              if (prev.some(m => m.content.includes(activeServer.osDetail))) return prev;
              
              return [
                ...prev, 
                { 
                    id: "os-info-" + Date.now(), 
                    role: "assistant", 
                    content: `✅ OS Detected: **${activeServer.osDetail}**.\nI will tailor my commands for this system.` 
                }
              ];
          });
      }
  }, [activeServer?.osDetail]);

  const scrollToBottom = () => {
    if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const runCommand = (cmd: string) => {
      const lines = cmd.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));

      let cleanCmd = '';
      let needsSeparator = false;

      for (let i = 0; i < lines.length; i++) {
          let line = lines[i];
          let isContinuation = false;

          // Handle line continuation char
          if (line.endsWith('\\')) {
              line = line.slice(0, -1).trim();
              isContinuation = true;
          }

          // Check if line ends with an operator that makes '&&' redundant
          if (line.endsWith('&&') || line.endsWith('||') || line.endsWith(';')) {
              isContinuation = true;
          }

          if (i === 0) {
              cleanCmd = line;
          } else {
              if (needsSeparator) {
                  cleanCmd += ' && ' + line;
              } else {
                  cleanCmd += ' ' + line;
              }
          }
          
          // If this line was a continuation, we don't need a separator before the next line
          needsSeparator = !isContinuation;
      }
      
      window.dispatchEvent(new CustomEvent('run-terminal-command', { detail: cleanCmd }));
  };

  const renderMessage = (content: string) => {
      // Split by code blocks
      const parts = content.split(/(```[\s\S]*?```)/g);
      return parts.map((part, i) => {
          if (part.startsWith('```')) {
              const match = part.match(/```(\w*)\n?([\s\S]*?)```/);
              const code = match ? match[2] : part.slice(3, -3);
              return (
                  <div key={i} className="my-2 bg-[#0f1115] rounded border border-zinc-800 overflow-hidden group">
                      <div className="flex justify-between items-center px-2 py-1 bg-zinc-900 border-b border-zinc-800">
                          <span className="text-[10px] text-zinc-500 font-mono">CODE</span>
                          <button 
                            onClick={() => runCommand(code)}
                            className="flex items-center gap-1 text-[10px] bg-blue-900/30 text-blue-400 px-1.5 py-0.5 rounded hover:bg-blue-900/50 transition-colors"
                          >
                              <Play className="w-3 h-3" />
                              RUN
                          </button>
                      </div>
                      <pre className="p-2 text-xs font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap">
                          {code.trim()}
                      </pre>
                  </div>
              );
          }
          // Render markdown for text parts
          return (
            <div key={i} className="prose prose-invert prose-xs max-w-none mb-2 leading-normal text-zinc-300">
                <ReactMarkdown>{part}</ReactMarkdown>
            </div>
          );
      });
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    await processAiInteraction([...messages, userMessage]);
  };

  const processAiInteraction = async (conversationHistory: Message[], hiddenSystemContext?: string) => {
    try {
      const historyContext = terminalHistory?.current 
          ? `\n\n[LAST 50 LINES OF TERMINAL OUTPUT]\n${terminalHistory.current.slice(-3000)}` 
          : "";

      const context = (activeServer 
        ? `Connected to ${activeServer.name} (${activeServer.osDetail || activeServer.type} - ${activeServer.ip})` 
        : "No active server connection.") + historyContext + (hiddenSystemContext ? `\n\n[SYSTEM UPDATE]: ${hiddenSystemContext}` : "");

      // Last message is the user input or system update
      const lastMsg = conversationHistory[conversationHistory.length - 1];

      const res = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            message: lastMsg.content,
            context: context,
            model: selectedModel
        }),
      });

      const data = await res.json();
      const responseContent = data.response || "Sorry, I couldn't process that.";
      
      // Check if model auto-switched
      if (data.usedModel && data.usedModel !== selectedModel) {
          setSelectedModel(data.usedModel); // Update selector
          const displayModelName = data.usedModel.includes("gemma") ? "Gemma 3 (Standard)" : "Flash 2.5 (Smart)";
          setMessages(prev => [...prev, {
              id: "sys-switch-" + Date.now(),
              role: "assistant",
              content: `⚠️ **System Notice**: Automatically switched to **${displayModelName}** due to provider limits.`
          }]);
      }

      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: responseContent,
      };
      
      setMessages((prev) => [...prev, aiMessage]);

      // Auto-Run Logic
      if (isAutoRun) {
          const codeMatches = [...responseContent.matchAll(/```(\w*)\n?([\s\S]*?)```/g)];
          
          if (codeMatches.length > 0) {
              const fullScript = codeMatches.map(match => match[2].trim()).join('\n');
              console.log("Auto-Running combined script:", fullScript);
              
              // Capture current history length to know what is NEW output
              const startLength = terminalHistory?.current?.length || 0;
              
              // Execute
              runCommand(fullScript);

              // Wait and Analyze loop
              setIsLoading(true); // Keep loading state
              
              setTimeout(() => {
                  const currentLength = terminalHistory?.current?.length || 0;
                  const newOutput = terminalHistory?.current?.substring(startLength) || "";
                  
                  if (newOutput.trim().length > 0) {
                      console.log("Capturing Auto-Run Output for AI analysis...");
                      const autoMsg: Message = {
                          id: Date.now().toString(),
                          role: "user", // Act as user to feed info back
                          content: `[AUTOMATED SYSTEM OUTPUT]\nThe command has been executed. Here is the output:\n\`\`\`\n${newOutput}\n\`\`\`\n\nPlease analyze this output and confirm if it was successful or if further actions are needed. Answer briefly.`
                      };
                      // Add to UI? Maybe useful to see, or keep it hidden?
                      // User wants to see "Yes it is installed". 
                      // Let's add it to conversation but maybe style it differently or just as a normal user message for now for transparency.
                      // setMessages(prev => [...prev, autoMsg]); // Uncomment to show the system feedback in chat
                      
                      // Recursive call
                      processAiInteraction([...conversationHistory, aiMessage, autoMsg], `The user has auto-run mode enabled. The command you provided was executed. The output was: ${newOutput}`);
                  } else {
                      setIsLoading(false);
                  }
              }, 4000); // Wait 4s for command to produce output
          } else {
              setIsLoading(false);
          }
      } else {
          setIsLoading(false);
      }

    } catch (error) {
      console.error(error);
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: "assistant", content: "Error connecting to AI service." },
      ]);
      setIsLoading(false);
    }
  };

  const isElectron = navigator.userAgent.toLowerCase().includes(' electron/');

  return (
    <div className="flex flex-col h-full text-zinc-300 bg-zinc-900/30 relative">
      {/* Header */}
      <div 
        className="h-10 px-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50 shrink-0"
        style={{ 
            WebkitAppRegion: isElectron ? 'drag' : undefined,
            paddingRight: isElectron ? '160px' : undefined 
        } as any}
      >
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <Sparkles className="w-3.5 h-3.5 text-teal-500" />
            <span className="font-bold text-xs text-zinc-300 uppercase tracking-wider hidden sm:inline">AI Assistant</span>
            
            {/* Model Selector */}
            <select 
                value={selectedModel} 
                onChange={(e) => handleModelChange(e.target.value)}
                className="bg-zinc-900 text-[10px] text-zinc-400 border border-zinc-700 rounded px-1 py-0.5 outline-none focus:border-teal-500 ml-2"
            >
                <option value="gemini-2.5-flash">Flash 2.5 (Smart)</option>
                <option value="gemma-3-27b-it">Gemma 3 (Standard)</option>
            </select>
        </div>
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <button 
                onClick={toggleAutoRun}
                className={clsx(
                    "p-1.5 rounded transition-colors flex items-center gap-1 text-[10px] font-bold border",
                    isAutoRun 
                        ? "bg-amber-500/20 text-amber-400 border-amber-500/50" 
                        : "text-zinc-500 border-transparent hover:bg-zinc-800"
                )}
                title="Auto-Run Commands"
            >
                <Zap className="w-3 h-3 fill-current" />
                {isAutoRun && "AUTO"}
            </button>
        </div>
      </div>

      {/* Messages */}
      <div 
        className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6" 
        ref={messagesContainerRef}
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={clsx(
              "flex flex-col gap-1 max-w-[95%]",
              msg.role === "user" ? "ml-auto items-end" : "items-start"
            )}
          >
            <div className="flex items-center gap-2 mb-1">
                {msg.role === 'assistant' && <Bot className="w-3 h-3 text-teal-500" />}
                <span className="text-[10px] text-zinc-500 font-medium uppercase">
                    {msg.role === 'user' ? 'You' : 'ShellMind'}
                </span>
            </div>
            
            <div className={clsx(
                "px-3 py-2 text-sm leading-relaxed rounded-md w-full",
                msg.role === "user" 
                    ? "bg-zinc-800 text-zinc-100 border border-zinc-700" 
                    : "text-zinc-300"
            )}>
              {renderMessage(msg.content)}
            </div>
          </div>
        ))}
        {isLoading && (
            <div className="flex flex-col gap-1">
                 <div className="flex items-center gap-2 mb-1">
                    <Bot className="w-3 h-3 text-teal-500" />
                    <span className="text-[10px] text-zinc-500 font-medium uppercase">ShellMind</span>
                 </div>
                 <div className="flex items-center gap-2 text-zinc-500 text-xs pl-1">
                    <RotateCw className="w-3 h-3 animate-spin" />
                    <span>Generating response...</span>
                 </div>
            </div>
        )}
      </div>

      {/* Input Area */}
      <div className="p-3 border-t border-zinc-800 bg-zinc-900/50 shrink-0">
        <div className="relative">
            <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                    }
                }}
                placeholder="Type a command or question..."
                className="w-full bg-black text-zinc-200 text-sm p-3 pr-10 rounded border border-zinc-800 focus:border-zinc-600 focus:ring-0 focus:outline-none resize-none scrollbar-hide min-h-[80px]"
            />
            <button 
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="absolute right-2 bottom-2 p-1.5 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent text-zinc-400 hover:text-white rounded transition-colors"
            >
                <Send className="w-3.5 h-3.5" />
            </button>
        </div>
        <div className="flex justify-between items-center mt-2 px-1">
             <span className="text-[10px] text-zinc-600">Context: {activeServer ? 'Active' : 'None'}</span>
             <span className="text-[10px] text-zinc-700">Enter to send, Shift+Enter for new line</span>
        </div>
      </div>
    </div>
  );
}
