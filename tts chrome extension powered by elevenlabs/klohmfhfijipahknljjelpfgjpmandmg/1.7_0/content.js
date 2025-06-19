const codec = "audio/mpeg";
const maxBufferDuration = 90;
let streamingCompleted = true;
const mediaSource = new MediaSource();
const audioElement = new Audio();

const ttsButton = document.createElement("img");
ttsButton.id = "ttsButton";
ttsButton.alt = "Text to speech button";
ttsButton.setAttribute("role", "button");
ttsButton.src = chrome.runtime.getURL("images/play.svg");
ttsButton.style.display = "none";
document.body.appendChild(ttsButton);

// New hover button for word-level reading
const hoverButton = document.createElement("img");
hoverButton.id = "hoverTtsButton";
hoverButton.alt = "Read from here button";
hoverButton.setAttribute("role", "button");
hoverButton.src = chrome.runtime.getURL("images/play.svg");
hoverButton.style.cssText = `
  position: absolute;
  width: 20px;
  height: 20px;
  cursor: pointer;
  z-index: 10000;
  display: none;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 4px;
  padding: 3px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  border: 1px solid rgba(0,0,0,0.1);
  transition: all 0.2s ease;
`;
document.body.appendChild(hoverButton);

// Highlighter element for current word
const highlighter = document.createElement("div");
highlighter.id = "ttsHighlighter";
highlighter.style.cssText = `
  position: absolute;
  background: rgba(255, 255, 0, 0.3);
  border: 2px solid rgba(255, 255, 0, 0.6);
  border-radius: 3px;
  pointer-events: none;
  z-index: 9999;
  display: none;
  transition: all 0.2s ease;
`;
document.body.appendChild(highlighter);

let buttonState = "play";
let currentHoveredElement = null;
let hoverTimeout = null;
let hideTimeout = null;
let isStopped = false;
let isHoveringButton = false;
let isPaused = false;
let lastPausedPosition = 0;
let currentTextToRead = "";
let currentWords = [];
let currentWordIndex = 0;
let wordTimings = [];
let isAutoScrollEnabled = true;
let hasUserScrolled = false;
let lastScrollTime = 0;

const setButtonState = (state) => {
  if (state === "loading") {
    buttonState = "loading";
    ttsButton.src = chrome.runtime.getURL("images/spinner.svg");
    hoverButton.src = chrome.runtime.getURL("images/spinner.svg");
    ttsButton.disabled = true;
    hoverButton.disabled = true;
  } else if (state === "play") {
    buttonState = "play";
    ttsButton.src = chrome.runtime.getURL("images/play.svg");
    hoverButton.src = chrome.runtime.getURL("images/play.svg");
    ttsButton.disabled = false;
    hoverButton.disabled = false;
    audioElement.pause();
    hideHighlighter();
  } else if (state === "speak") {
    buttonState = "speak";
    ttsButton.src = chrome.runtime.getURL("images/stop.svg");
    hoverButton.src = chrome.runtime.getURL("images/stop.svg");
    ttsButton.disabled = false;
    hoverButton.disabled = false;
  } else if (state === "paused") {
    buttonState = "paused";
    ttsButton.src = chrome.runtime.getURL("images/play.svg");
    hoverButton.src = chrome.runtime.getURL("images/play.svg");
    ttsButton.disabled = false;
    hoverButton.disabled = false;
    audioElement.pause();
  }
};

let textToPlay = "";
const setTextToPlay = (text) => {
  textToPlay = text;
  currentTextToRead = text;
  currentWords = text.split(/\s+/).filter(word => word.trim().length > 0);
  currentWordIndex = 0;
  wordTimings = [];
  // Build text segments for accurate highlighting
  buildTextSegments(text);
};

// Function to get all readable text elements from the page
const getAllTextElements = () => {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        // Skip script, style, and other non-readable elements
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        
        const tagName = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'nav', 'header', 'footer'].includes(tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Skip if text is empty or just whitespace
        if (!node.textContent || node.textContent.trim().length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Check if element is visible
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return NodeFilter.FILTER_REJECT;
        }
        
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  
  const textNodes = [];
  let node;
  while (node = walker.nextNode()) {
    textNodes.push(node);
  }
  return textNodes;
};

// Function to get text from a specific element to the end of the page
const getTextFromWordToEnd = (startElement) => {
  try {
    const allTextNodes = getAllTextElements();
    let startFound = false;
    let result = "";
    
    // Find the starting point
    for (const textNode of allTextNodes) {
      if (textNode === startElement || textNode.parentElement === startElement || 
          textNode.parentElement.contains(startElement) || startElement.contains(textNode)) {
        startFound = true;
      }
      
      if (startFound) {
        const text = textNode.textContent.trim();
        if (text) {
          result += (result ? " " : "") + text;
        }
      }
    }
    
    // If we didn't find enough text, get more context
    if (result.trim().length < 50) {
      const allText = document.body.innerText || document.body.textContent || "";
      const lines = allText.split('\n').filter(line => line.trim().length > 0);
      result = lines.join(' ');
    }
    
    return result.trim();
  } catch (error) {
    console.error("Error getting text:", error);
    return document.body.innerText || document.body.textContent || "";
  }
};

// Function to store text segments with their DOM positions for highlighting
let textSegments = [];
let currentSegmentIndex = 0;

// Function to build text segments map for accurate highlighting
const buildTextSegments = (text) => {
  textSegments = [];
  const words = text.split(/\s+/).filter(word => word.trim().length > 0);
  
  // Find all text nodes that contain our words
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        
        const tagName = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript'].includes(tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        if (!node.textContent || node.textContent.trim().length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  
  let textNodes = [];
  let node;
  while (node = walker.nextNode()) {
    textNodes.push(node);
  }
  
  // Build segments with DOM references
  let wordIndex = 0;
  let currentText = text.toLowerCase();
  let searchStart = 0;
  
  for (let i = 0; i < words.length && wordIndex < words.length; i++) {
    const word = words[i];
    const wordLower = word.toLowerCase();
    
    // Find this word in the original text
    const wordPosition = currentText.indexOf(wordLower, searchStart);
    if (wordPosition === -1) {
      wordIndex++;
      continue;
    }
    
    // Find which text node contains this word
    let cumulativeLength = 0;
    let targetNode = null;
    let nodeOffset = 0;
    
    for (const textNode of textNodes) {
      const nodeText = textNode.textContent;
      const nodeLength = nodeText.length;
      
      if (wordPosition >= cumulativeLength && wordPosition < cumulativeLength + nodeLength) {
        targetNode = textNode;
        nodeOffset = wordPosition - cumulativeLength;
        break;
      }
      cumulativeLength += nodeLength + 1; // +1 for space between nodes
    }
    
    if (targetNode) {
      textSegments.push({
        word: word,
        node: targetNode,
        offset: nodeOffset,
        length: word.length,
        index: wordIndex
      });
    }
    
    searchStart = wordPosition + wordLower.length;
    wordIndex++;
  }
  
  console.log("Built", textSegments.length, "text segments for highlighting");
};

// Function to highlight current word using pre-built segments
// Function to highlight current word using pre-built segments
const highlightWord = (wordIndex) => {
  // Safety checks
  if (!textSegments || textSegments.length === 0) {
    console.warn("highlightWord: No text segments available");
    return;
  }
  
  if (wordIndex < 0 || wordIndex >= textSegments.length) {
    console.warn("highlightWord: Invalid word index", wordIndex, "of", textSegments.length);
    return;
  }
  
  try {
    const segment = textSegments[wordIndex];
    if (!segment || !segment.node || !segment.node.textContent) {
      console.warn("highlightWord: Invalid segment at index", wordIndex);
      return;
    }
    
    // Verify the node is still in the DOM
    if (!document.contains(segment.node)) {
      console.warn("highlightWord: Node no longer in DOM");
      return;
    }
    
    // Verify offset bounds
    const nodeTextLength = segment.node.textContent.length;
    if (segment.offset < 0 || segment.offset >= nodeTextLength) {
      console.warn("highlightWord: Invalid offset", segment.offset, "for node length", nodeTextLength);
      return;
    }
    
    // Verify end position
    const endOffset = segment.offset + segment.length;
    if (endOffset > nodeTextLength) {
      console.warn("highlightWord: End offset exceeds node length");
      return;
    }
    
    const range = document.createRange();
    range.setStart(segment.node, segment.offset);
    range.setEnd(segment.node, endOffset);
    
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      highlighter.style.left = (rect.left + window.scrollX) + 'px';
      highlighter.style.top = (rect.top + window.scrollY) + 'px';
      highlighter.style.width = rect.width + 'px';
      highlighter.style.height = rect.height + 'px';
      highlighter.style.display = 'block';
      
      console.log("Highlighting word:", segment.word, "at index", wordIndex);
      
      // Auto-scroll if enabled and user hasn't scrolled recently
      if (isAutoScrollEnabled && (Date.now() - lastScrollTime) > 2000) {
        const viewportTop = window.scrollY;
        const viewportBottom = viewportTop + window.innerHeight;
        const elementTop = rect.top + window.scrollY;
        const elementBottom = elementTop + rect.height;
        
        // Check if element is outside viewport
        if (elementTop < viewportTop || elementBottom > viewportBottom) {
          const targetScroll = elementTop - (window.innerHeight / 3);
          window.scrollTo({
            top: Math.max(0, targetScroll),
            behavior: 'smooth'
          });
        }
      }
    } else {
      console.warn("highlightWord: Invalid rectangle dimensions");
    }
  } catch (error) {
    console.error("Error highlighting word:", error);
    // Hide highlighter on error to prevent visual glitches
    hideHighlighter();
  }
};

// Function to hide highlighter
const hideHighlighter = () => {
  highlighter.style.display = 'none';
};

// Track user scrolling
let scrollTimeout;
window.addEventListener('scroll', () => {
  hasUserScrolled = true;
  lastScrollTime = Date.now();
  
  // Re-enable auto-scroll after 3 seconds of no scrolling
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    hasUserScrolled = false;
  }, 3000);
});

// Function to get word boundaries and position
const getWordRect = (element) => {
  if (!element) return null;
  
  const range = document.createRange();
  if (element.nodeType === Node.TEXT_NODE) {
    range.selectNodeContents(element);
  } else {
    range.selectNode(element);
  }
  
  const rects = range.getClientRects();
  return rects.length > 0 ? rects[0] : null;
};

const readStorage = async (keys) => {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, function (result) {
      resolve(result);
    });
  });
};

const fetchResponse = async () => {
  const storage = await readStorage(["apiKey", "selectedVoiceId", "mode"]);
  const selectedVoiceId = storage.selectedVoiceId
    ? storage.selectedVoiceId
    : "21m00Tcm4TlvDq8ikWAM"; //fallback Voice ID
  const mode = storage.mode
  const model_id =
    (mode === "englishfast" || mode === "eleven_turbo_v2") ? "eleven_turbo_v2" :
      (mode === "multilingual" || mode === "eleven_multilingual_v2") ? "eleven_multilingual_v2" :
        "eleven_turbo_v2_5";

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}/stream`,
    {
      method: "POST",
      headers: {
        Accept: codec,
        "xi-api-key": storage.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: model_id,
        text: textToPlay,
        voice_settings: {
          similarity_boost: 0.5,
          stability: 0.5,
        },
      }),
    }
  );
  return response;
};

const handleMissingApiKey = () => {
  setButtonState("speak");
  const audio = new Audio(chrome.runtime.getURL("media/error-no-api-key.mp3"));
  audio.play();
  //since alert() is blocking, timeout is needed so audio plays while alert is visible.
  setTimeout(() => {
    alert(
      "Please set your Elevenlabs API key in the extension settings to use Human Reader."
    );
    chrome.storage.local.clear();
    setButtonState("play");
  }, 100);
};

const clearBuffer = () => {
  if (mediaSource.readyState === "open") {
    const sourceBuffers = mediaSource.sourceBuffers;
    for (let i = 0; i < sourceBuffers.length; i++) {
      sourceBuffers[i].abort();
      mediaSource.removeSourceBuffer(sourceBuffers[i]);
    }
  }
  audioElement.pause();
  audioElement.src = "";
  streamingCompleted = true;
  hideHighlighter();
};

const stopAudio = () => {
  isStopped = true;
  isPaused = false;
  lastPausedPosition = 0;
  currentWordIndex = 0;
  clearBuffer();
  setButtonState("play");
};

const pauseAudio = () => {
  if (buttonState === "speak") {
    isPaused = true;
    lastPausedPosition = audioElement.currentTime;
    audioElement.pause();
    setButtonState("paused");
    console.log("Audio paused at:", lastPausedPosition);
  }
};

const resumeAudio = () => {
  if (isPaused && buttonState === "paused") {
    audioElement.currentTime = lastPausedPosition;
    audioElement.play();
    setButtonState("speak");
    isPaused = false;
    console.log("Audio resumed from:", lastPausedPosition);
  }
};

let sourceOpenEventAdded = false;
const streamAudio = async () => {
  const storage = await readStorage(["apiKey", "speed"]);
  if (!storage.apiKey) {
    handleMissingApiKey();
    return;
  }
  isStopped = false;
  streamingCompleted = false;
  audioElement.src = URL.createObjectURL(mediaSource);
  const playbackRate = storage.speed ? storage.speed : 1;
  audioElement.playbackRate = playbackRate;
  audioElement.play();
  
  // Estimate word timings (rough approximation)
  const estimatedDuration = currentWords.length / (150 * playbackRate / 60); // ~150 words per minute
  
  // Initialize word highlighting
  currentWordIndex = 0;
  if (textSegments.length > 0) {
    // Start highlighting from the beginning or resume position
    const startWordIndex = isPaused ? Math.floor((lastPausedPosition / estimatedDuration) * currentWords.length) : 0;
    currentWordIndex = Math.max(0, Math.min(startWordIndex, textSegments.length - 1));
    console.log("Starting highlight from word index:", currentWordIndex);
  }
  
  if (!sourceOpenEventAdded) {
    sourceOpenEventAdded = true;
    mediaSource.addEventListener("sourceopen", () => {
      const sourceBuffer = mediaSource.addSourceBuffer(codec);

      let isAppending = false;
      let appendQueue = [];

      const processAppendQueue = () => {
        if (!isAppending && appendQueue.length > 0) {
          isAppending = true;
          const chunk = appendQueue.shift();
          if (chunk && mediaSource.sourceBuffers.length > 0) {
            sourceBuffer.appendBuffer(chunk);
          } else {
            isAppending = false;
          }
        }
      };

      sourceBuffer.addEventListener("updateend", () => {
        isAppending = false;
        processAppendQueue();
      });

      const appendChunk = (chunk) => {
        if (isStopped) return;

        setButtonState("speak");
        appendQueue.push(chunk);
        processAppendQueue();

        while (
          mediaSource.duration - mediaSource.currentTime >
          maxBufferDuration
        ) {
          const removeEnd = mediaSource.currentTime - maxBufferDuration;
          sourceBuffer.remove(0, removeEnd);
        }
      };

      const fetchAndAppendChunks = async () => {
        try {
          const response = await fetchResponse();

          if (response.status === 401) {
            const errorBody = await response.json();
            const errorStatus = errorBody.detail.status
            if (errorStatus === "detected_unusual_activity" || errorStatus === "quota_exceeded") {
              alert(`MESSAGE FROM ELEVENLABS: ${errorBody.detail.message}`);
            } else {
              alert("Unauthorized. Please set your API key again.");
              chrome.storage.local.clear();
            }
            setButtonState("play");
            return;
          }

          if (!response.body) {
            const errorMessage = "Error fetching audio, please try again";
            alert(errorMessage);
            console.error(errorMessage);
            setButtonState("play");
            return;
          }

          const reader = response.body.getReader();

          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              // Signal the end of the stream
              streamingCompleted = true;
              break;
            }

            appendChunk(value.buffer);
          }
        } catch (error) {
          setButtonState("play");
          console.error("Error fetching and appending chunks:", error);
        }
      };
      fetchAndAppendChunks();
    });
  }
};

async function onClickTtsButton() {
  if (buttonState === "paused") {
    resumeAudio();
    return;
  }
  
  if (buttonState === "loading" || buttonState === "speak") {
    stopAudio();
    return;
  }
  setButtonState("loading");
  try {
    setTextToPlay(window.getSelection().toString());
    await streamAudio();
  } catch (error) {
    console.error(error);
    setButtonState("play");
  }
}

// New function for hover button click
async function onClickHoverButton() {
  console.log("Hover button clicked!", currentHoveredElement);
  
  if (buttonState === "paused") {
    resumeAudio();
    return;
  }
  
  if (buttonState === "loading" || buttonState === "speak") {
    console.log("Stopping current audio");
    stopAudio();
    return;
  }
  
  if (!currentHoveredElement) {
    console.log("No hovered element found");
    alert("No text element found. Please try hovering over text content.");
    return;
  }
  
  setButtonState("loading");
  try {
    const textFromWord = getTextFromWordToEnd(currentHoveredElement);
    console.log("Text to read length:", textFromWord.length);
    console.log("Text preview:", textFromWord.substring(0, 200) + "...");
    
    if (!textFromWord || textFromWord.trim().length < 10) {
      console.log("Text too short:", textFromWord);
      alert("Not enough text found to read. Please try hovering over a paragraph or article.");
      setButtonState("play");
      return;
    }
    
    // Limit text length to prevent API issues
    const maxLength = 5000;
    const finalText = textFromWord.length > maxLength 
      ? textFromWord.substring(0, maxLength) + "..."
      : textFromWord;
    
    console.log("Final text length:", finalText.length);
    setTextToPlay(finalText);
    await streamAudio();
  } catch (error) {
    console.error("Error in hover button click:", error);
    alert("Error: " + error.message);
    setButtonState("play");
  }
}

// Click handler for blank areas (pause functionality)
document.addEventListener("click", function(e) {
  // Only pause if we're currently speaking and clicked on a blank area
  if (buttonState !== "speak") return;
  
  const target = e.target;
  
  // Don't pause if clicking on interactive elements or buttons
  if (target === ttsButton || target === hoverButton || target === highlighter) return;
  if (target.tagName === "A" || target.tagName === "BUTTON" || target.tagName === "INPUT" || 
      target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
  if (target.closest('button, a, input, textarea, select, [role="button"]')) return;
  
  // Check if clicked on mostly empty space
  const style = window.getComputedStyle(target);
  const hasMinimalText = !target.textContent || target.textContent.trim().length < 5;
  const isContainer = ['BODY', 'DIV', 'MAIN', 'SECTION', 'ARTICLE', 'HTML'].includes(target.tagName);
  
  if (hasMinimalText && isContainer) {
    pauseAudio();
  }
});

// Hide hover button with delay
const hideHoverButton = () => {
  // Clear any existing timeouts
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  
  // Only hide if not hovering over the button itself
  if (!isHoveringButton) {
    hideTimeout = setTimeout(() => {
      hoverButton.style.display = "none";
      currentHoveredElement = null;
    }, 500); // 500ms delay before hiding
  }
};

// Show hover button at specific position
const showHoverButton = (element, x, y) => {
  // Clear any hide timeout
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  
  currentHoveredElement = element;
  hoverButton.style.left = (x - 15) + "px";
  hoverButton.style.top = (y - 30) + "px";
  hoverButton.style.display = "block";
  console.log("Hover button shown at:", x, y);
};

// Mouse move handler for word detection
document.addEventListener("mousemove", function(e) {
  // Clear existing timeout
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  
  // Skip if we're currently playing audio (but allow when paused)
  if (buttonState === "speak" || buttonState === "loading") {
    return;
  }
  
  const element = document.elementFromPoint(e.clientX, e.clientY);
  
  // Check if hovering over the hover button itself
  if (element === hoverButton) {
    isHoveringButton = true;
    return;
  } else {
    isHoveringButton = false;
  }
  
  // Skip non-text elements and form inputs
  if (!element || 
      element.tagName === "INPUT" || 
      element.tagName === "TEXTAREA" || 
      element.tagName === "BUTTON" ||
      element.tagName === "A" ||
      element.isContentEditable ||
      element === ttsButton ||
      element.closest('input, textarea, button, select, nav, header, footer')) {
    hideHoverButton();
    return;
  }
  
  // Check if element has readable text content (improved detection for dynamic content)
  const hasText = element.textContent && element.textContent.trim().length > 3;
  const isVisible = element.offsetParent !== null;
  
  if (hasText && isVisible) {
    // Set timeout to show button after brief hover
    hoverTimeout = setTimeout(() => {
      console.log("Showing hover button for element:", element.tagName, element.textContent.substring(0, 50));
      showHoverButton(element, e.pageX, e.pageY);
    }, 150); // Reduced delay to 150ms
  } else {
    hideHoverButton();
  }
});

// Add mouse leave handler for the hover button
hoverButton.addEventListener("mouseenter", () => {
  isHoveringButton = true;
  console.log("Mouse entered hover button");
});

hoverButton.addEventListener("mouseleave", () => {
  isHoveringButton = false;
  console.log("Mouse left hover button");
  hideHoverButton();
});

// Hide button when mouse leaves the page
document.addEventListener("mouseleave", hideHoverButton);

// Enhanced audio time tracking for word highlighting
audioElement.addEventListener("timeupdate", () => {
  // Update word highlighting during playback
  if (buttonState === "speak" && textSegments.length > 0 && audioElement.duration > 0) {
    const currentTime = audioElement.currentTime;
    const totalDuration = audioElement.duration;
    
    // Calculate current word index based on time progression
    const progressRatio = currentTime / totalDuration;
    const estimatedWordIndex = Math.floor(progressRatio * textSegments.length);
    
    if (estimatedWordIndex !== currentWordIndex && estimatedWordIndex < textSegments.length && estimatedWordIndex >= 0) {
      currentWordIndex = estimatedWordIndex;
      highlightWord(currentWordIndex);
      console.log("Updated word index to:", currentWordIndex, "at time:", currentTime.toFixed(2));
    }
  }
  
  // Check for audio end (existing logic)
  const playbackEndThreshold = 0.5;
  if (streamingCompleted) {
    if (audioElement.buffered.length > 0) {
      const bufferEndTime = audioElement.buffered.end(audioElement.buffered.length - 1);
      const timeLeft = bufferEndTime - audioElement.currentTime;

      if (timeLeft <= playbackEndThreshold) {
        setButtonState("play");
        currentWordIndex = 0;
        hideHighlighter();
      }
    }
  }
});

// Keep existing selection functionality
document.addEventListener("selectionchange", function () {
  const selection = window.getSelection();

  if (!selection.anchorNode || !selection.focusNode) {
    return;
  }

  // Detect if input element was selected
  if (selection.anchorNode.tagName === "FORM" || selection.focusNode.tagName === "INPUT") {
    return;
  }
  if (!selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    const lastRect = rects[rects.length - 1];
    ttsButton.style.left = window.scrollX + lastRect.right + "px";
    ttsButton.style.top = window.scrollY + lastRect.bottom + "px";
    ttsButton.style.display = "block";
  } else {
    ttsButton.style.display = "none";
  }
  ttsButton.onclick = onClickTtsButton;
});

// Event listeners for buttons
ttsButton.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    onClickTtsButton();
  }
});

hoverButton.addEventListener("click", onClickHoverButton);
hoverButton.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    onClickHoverButton();
  }
});

// Receive sent message from background worker and trigger readOutLoud action
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "readOutLoud") {
    onClickTtsButton();
  }
  return true
});

document.addEventListener("keydown", function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "h") {
    onClickTtsButton();
  }
  
  // Space bar to pause/resume
  if (e.code === "Space" && (buttonState === "speak" || buttonState === "paused")) {
    // Only prevent default if we're not in an input field
    const activeElement = document.activeElement;
    const isInInput = activeElement && (
      activeElement.tagName === "INPUT" || 
      activeElement.tagName === "TEXTAREA" || 
      activeElement.isContentEditable
    );
    
    if (!isInInput) {
      e.preventDefault();
      if (buttonState === "speak") {
        console.log("Spacebar: pausing audio");
        pauseAudio();
      } else if (buttonState === "paused") {
        console.log("Spacebar: resuming audio");
        resumeAudio();
      }
    }
  }
});