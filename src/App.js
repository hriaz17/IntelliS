import React, { useState } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import OpenAI from 'openai';
import ReactMarkdown from 'react-markdown';  // For Markdown rendering
import {
  BedrockRuntimeClient,
  ContentBlockStart,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { diffLines } from 'diff';
import ReactDiffViewer from 'react-diff-viewer-continued';
import './App.css';

// Prism language registrations:
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import jsonLang from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import cssLang from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';

/* Register all languages for syntax highlighting */
[
  ['python', python],
  ['javascript', javascript],
  ['typescript', typescript],
  ['java', java],
  ['c', c],
  ['cpp', cpp],
  ['json', jsonLang],
  ['xml', markup],
  ['css', cssLang],
  ['markdown', markdown],
  ['yaml', yaml],
  ['bash', bash],
  ['ruby', ruby],
  ['go', go],
  ['swift', swift],
  ['rust', rust],
  ['php', php],
].forEach(([name, langModule]) => SyntaxHighlighter.registerLanguage(name, langModule));

/* Simple extension-to-language mapping */
const languageMap = {
  '.py': 'python',
  '.js': 'javascript',
  '.ts': 'typescript',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.json': 'json',
  '.html': 'xml',
  '.css': 'css',
  '.md': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'bash',
  '.bash': 'bash',
  '.rb': 'ruby',
  '.go': 'go',
  '.swift': 'swift',
  '.rs': 'rust',
  '.php': 'php'
};

// Backend API URL - update this with your backend URL
const API_URL = 'http://localhost:8000';

// Instantiate OpenAI client
const client = new OpenAI({
  apiKey: process.env.REACT_APP_OPENAI_API_KEY,
  // WARNING: This is not recommended for production. 
  // Typically, calls to OpenAI should be done from a secure server.
  dangerouslyAllowBrowser: true,
});

// Helper to compute changed file key from original filename.
const getChangedFileKey = (fileName) => {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex !== -1 
    ? fileName.slice(0, dotIndex) + "(change)" + fileName.slice(dotIndex)
    : fileName + "(change)";
};

const traverseFileTree = (node, path = "") => {
  const filesArr = [];
  // If the node is explicitly a file, add it.
  if (node.__isFile) {
    filesArr.push({ file: node.file, path });
  }
  // If it's explicitly a directory, traverse its keys.
  else if (node.__isDirectory) {
    Object.keys(node).forEach(key => {
      if (key !== "__isDirectory" && key !== "__expanded") {
        filesArr.push(...traverseFileTree(node[key], path ? `${path}/${key}` : key));
      }
    });
  }
  // If there is no flag, assume it's an object container.
  else if (typeof node === "object" && node !== null) {
    Object.keys(node).forEach(key => {
      filesArr.push(...traverseFileTree(node[key], path ? `${path}/${key}` : key));
    });
  }
  return filesArr;
};

// Helper function to search for main.py in the uploaded directories.
const findMainPy = (dirs) => {
  for (const dir of dirs) {
    const filesArr = traverseFileTree(dir.files, dir.name);
    for (const item of filesArr) {
      if (item.file.name === 'main.py') {
        return item;
      }
    }
  }
  return null;
};

// Updated function to run main.py by sending the folder path to the backend.
// The backend should then run: cd <folderPath> && python main.py
const runMainPy = async (mainFileItem) => {
  // Extract the folder path from the file's webkitRelativePath.
  // For example, "project_folder/subfolder/main.py" becomes "project_folder/subfolder".
  const pathParts = mainFileItem.file.webkitRelativePath.split('/');
  const folderPath = pathParts.slice(0, -1).join('/');
  
  try {
    const response = await fetch(`${API_URL}/run_main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folderPath })
    });
    const result = await response.json();
    console.log('main.py execution result:', result);
    // Optionally, update state or display result as needed.
  } catch (error) {
    console.error("Error running main.py:", error);
  }
};

// Main App Component
export default function App() {
  // State for feature description file
  const [featureFile, setFeatureFile] = useState(null); // .txt file
  const [featureContent, setFeatureContent] = useState(''); // final merged content
  const [filePreview, setFilePreview] = useState(''); // preview of .txt
  // State for feature description file
  // "You can't delete my feature" → start with some default text
  const [featureInput, setFeatureInput] = useState(
    '## My Base Feature\n\nThis is a default feature description that cannot be removed. You can add more details below.\n'
  );
  
  // State for uploaded code directories
  const [directories, setDirectories] = useState([]);
  // State for Highlighted files
  const [highlightedFile, setHighlightedFile] = useState(null);
  // State for the currently selected file to preview
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [showFilePreview, setShowFilePreview] = useState(false);

  // New state for LLM analysis
  const [llmResponse, setLlmResponse] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const [analysisProgress, setAnalysisProgress] = useState(0);

  // Changed files state
  const [changedFiles, setChangedFiles] = useState({});
  const [changedFilesProgress, setChangedFilesProgress] = useState(0);
  const [originalFiles, setOriginalFiles] = useState({});
  // Which file diff to show
  const [selectedDiff, setSelectedDiff] = useState(null);

  const [runOutput, setRunOutput] = useState("");
  
  // -------------------------
  // LOADING & PROGRESS
  // -------------------------
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  // New state to store the top-R (subset) docstrings result
  const [topRDocstrings, setTopRDocstrings] = useState(null);

  const [docstringResultsState, setDocstringResultsState] = useState(null);

  // Detect language for code preview
  const extension = selectedFile?.name.split('.').pop();
  const language = languageMap[`.${extension}`] || null;

  // Function to run main.py via backend endpoint /run_code
  const runCode = async () => {
    try {
      const response = await fetch(`${API_URL}/run_code`);
      const result = await response.json();
      setRunOutput(result.output || result.error);
    } catch (error) {
      setRunOutput("Error running code: " + error.message);
    }
  };


  const mainFileItem = findMainPy(directories);

  // Merged handleFeatureUpload function
  const handleFeatureUpload = (event) => {
    // Clear any previous LLM response and errors
    
    setLlmResponse(null);
    setAnalysisError(null);

    // If an event with a file exists, read the file first.
    if (event && event.target && event.target.files && event.target.files.length > 0) {
      const file = event.target.files[0];
      setFeatureFile(file);
      const reader = new FileReader();
      reader.onload = (e) => {
        const fileText = e.target.result;
        setFilePreview(fileText);
        mergeContent(fileText);
      };
      reader.readAsText(file);
    } else {
      // If no file event is present (e.g. "Upload ⬆" button click), merge using the current filePreview.
      mergeContent();
    }
  };

  // Helper function to merge typed text and file content
  const mergeContent = (fileTextFromEvent) => {
    const typed = featureInput.trim();
    // Use the file text passed from the event if available, otherwise fall back to filePreview state.
    const fileText = fileTextFromEvent || filePreview;
    // If there's nothing to merge, do nothing.
    if (!typed && !fileText) return;

    // Merge typed text and file text with a newline separator if both exist.
    const merged = typed && fileText ? `${typed}\n\n${fileText}` : (typed || fileText);
    setFeatureContent(merged);
  };


// Analyze feature description with LLM
const analyzeFeature = async () => {
  if (!featureContent) {
    setAnalysisError("Please upload a feature description first");
    return;
  }
  
  setIsLoading(true);
  setAnalysisError(null);
  setAnalysisProgress(0);

  // interval to simulate analysis progress
  const interval = setInterval(() => {
    setAnalysisProgress(prev => {
      // Increase progress gradually until 90%
      if (prev >= 90) return prev;
      return prev + 10;
    });
  }, 500);
  
  try {
    const response = await fetch(`${API_URL}/convert_high_to_low`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        feature_description: featureContent 
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}`);
    }
    
    const data = await response.json();
    setLlmResponse(data.analysis);
  } catch (error) {
    console.error('Error analyzing feature:', error);
    setAnalysisError(`Error: ${error.message}`);
  } finally {
    clearInterval(interval);
    setAnalysisProgress(100);
    setIsLoading(false);
  }
}; // <-- Close analyzeFeature here

/* -------------------------
 * 1) FEATURE DESCRIPTION
 * -------------------------
 */
// Handle .txt file selection
const handleFeatureFileChange = (event) => {
  const file = event.target.files[0];
  if (file) {
    setFeatureFile(file);
    // Show a preview of the .txt file (without merging yet)
    const reader = new FileReader();
    reader.onload = (e) => {
      setFilePreview(e.target.result);
    };
    reader.readAsText(file);
  }
};

// handle editing of feature description field
const handleFeatureInputChange = (event) => {
  setFeatureInput(event.target.value);
};

/* -------------------------
 * 2) CODE DIRECTORY UPLOAD
 * -------------------------
 */
const handleDirectoryUpload = async (event) => {
  const allFiles = Array.from(event.target.files);
  const files = allFiles.filter(file => file.name.endsWith('.py'));
  if (files.length === 0) return;

  setDirectories([
    {
      name: files[0].webkitRelativePath.split('/')[0],
      files: { __isDirectory: true, ...processFiles(files) },
      expanded: false
    }
  ]);

  // const randomIndex = 0;
  // setHighlightedFile(files[randomIndex]);

  setLoading(true);
  setProgress(0);
  
  // Collect docstrings in a dictionary { filepath: docstring }
  const docstringResults = {};
  const totalFiles = files.length;
  let completed = 0;

  await Promise.all(
    files.map(async (file) => {
      const content = await file.text();
      try {
        const prompt = `Generate a detailed string description/docstring for what this python code does.\nPath: ${file.webkitRelativePath}\n\`\`\`\n${content}\n\`\`\``;
        const instruction = `<｜begin▁of▁sentence｜><｜User｜>${prompt}<｜Assistant｜><think>`;
        const payload = {
          prompt: instruction,
          max_tokens: 2048,
          temperature: 0.5,
        };

        const bedrockClient = new BedrockRuntimeClient({
          region: process.env.REACT_APP_AWS_DEFAULT_REGION || "us-west-2",
          credentials: {
            accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY,
            sessionToken: process.env.REACT_APP_AWS_SESSION_TOKEN,
          },
        });
        
        const command = new InvokeModelCommand({
          contentType: "application/json",
          body: JSON.stringify(payload),
          modelId: "us.deepseek.r1-v1:0",
        });
        
        const apiResponse = await bedrockClient.send(command);
        const decodedResponseBody = new TextDecoder().decode(apiResponse.body);
        const responseBody = JSON.parse(decodedResponseBody);
        const result = responseBody.choices[0].text.trim();
        docstringResults[file.webkitRelativePath] = result;
      } catch (error) {
        console.error("Error fetching docstring from Bedrock:", error);
        docstringResults[file.webkitRelativePath] = "Error fetching docstring.";
      } finally {
        completed++;
        setProgress(Math.round((completed / totalFiles) * 100));
      }
    })
  );

  // 2) After all docstring extractions finish, optionally save docstrings to server
  try {
    await fetch(`${API_URL}/api/saveDocstrings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(docstringResults),
    });
  } catch (error) {
    console.error("Error saving docstrings to server:", error);
  }

  // 3) Store the docstring results in state for later use by the useEffect hook.
  setDocstringResultsState(docstringResults);
  setLoading(false);
  // console.log("All docstrings:", docstringResults);
};

const computeTopRFiles = async (lowLevelPlan, docstringResults) => {
  const payload = {
    low_level_plan: lowLevelPlan,
    docstring_results: docstringResults,
  };

  try {
    const response = await fetch(`${API_URL}/api/saveTopR`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}`);
    }
    
    const data = await response.json();
    // Expect the backend to return { status: 'success', top_r_docstrings: { ... } }
    return data.top_r_docstrings;
  } catch (error) {
    console.error("Error computing top-R files:", error);
    return null;
  }
};

React.useEffect(() => {
  async function computeTopRIfReady() {
    if (llmResponse && docstringResultsState) {
      console.log("Both llmResponse and docstringResultsState are available. Computing top-R subset...");
      const topR = await computeTopRFiles(llmResponse, docstringResultsState);
      setTopRDocstrings(topR);
      // Do not send another fetch here, since computeTopRFiles already called /api/saveTopR.
    }
  }
  computeTopRIfReady();
}, [llmResponse, docstringResultsState]);


function processFiles(files) {
  const fileTree = {};

  files.forEach((file) => {
    const pathParts = file.webkitRelativePath.split('/');

    if (pathParts.some((segment) => segment.startsWith('.'))) {
      return;
    }

    let currentLevel = fileTree;
    for (let i = 1; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!currentLevel[part]) {
        currentLevel[part] = { __isDirectory: true, __expanded: false };
      }
      currentLevel = currentLevel[part];
    }

    const fileName = pathParts[pathParts.length - 1];
    if (fileName.startsWith('.')) {
      return;
    }

    // Otherwise, store it in the file tree
    currentLevel[fileName] = { __isFile: true, file };
  });

  return fileTree;
}

// Toggle directory expand/collapse
const toggleDirectory = (dirPath, dirs) => {
  const updatedDirs = [...dirs];
  const pathParts = dirPath.split('/');

  // Top-level directory
  if (pathParts.length === 1) {
    const dirIndex = updatedDirs.findIndex(d => d.name === pathParts[0]);
    if (dirIndex !== -1) {
      updatedDirs[dirIndex].expanded = !updatedDirs[dirIndex].expanded;
    }
  } else {
    // Nested directory
    const topDirName = pathParts[0];
    const topDirIndex = updatedDirs.findIndex(d => d.name === topDirName);
    if (topDirIndex === -1) return;

    let currentDir = updatedDirs[topDirIndex].files;
    for (let i = 1; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (currentDir[part] && currentDir[part].__isDirectory) {
        currentDir = currentDir[part];
      } else {
        return;
      }
    }

    const targetDir = pathParts[pathParts.length - 1];
    if (currentDir[targetDir] && currentDir[targetDir].__isDirectory) {
      currentDir[targetDir].__expanded = !currentDir[targetDir].__expanded;
    }
  }

  setDirectories(updatedDirs);
};

// File click → show preview
const handleFileClick = (file) => {
  setSelectedFile(file);

  const reader = new FileReader();
  reader.onload = (e) => {
    setFileContent(e.target.result);
    setShowFilePreview(true);
  };
  reader.readAsText(file);
};

// Close preview
const closeFilePreview = () => {
  setShowFilePreview(false);
  setSelectedFile(null);
  setFileContent('');
};

// Recursive directory rendering
const renderDirectory = (dir, path = '') => {
  if (dir.__isDirectory) {
    const dirName = path.split('/').pop();
    const isExpanded = dir.__expanded;

    return (
      <div className="directory">
        <div
          className="directory-name"
          onClick={() => toggleDirectory(path, directories)}
        >
          {isExpanded ? '📂' : '📁'} {dirName}
        </div>
        {isExpanded && (
          <div className="directory-contents">
            {Object.keys(dir)
              .filter(key => key !== '__isDirectory' && key !== '__expanded')
              .map(key => {
                const newPath = `${path}/${key}`;
                return (
                  <div key={newPath} className="file-item">
                    {renderDirectory(dir[key], newPath)}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    );
  } else if (dir.__isFile) {
    // It's a file node
    const relativePath = path;
    const fileName = relativePath.split('/').pop();
    const isChanged = changedFiles.hasOwnProperty(fileName);
    return (
      <div
        className={`file-name ${isChanged ? "changed-highlight" : ""} ${
          highlightedFile && ((highlightedFile.webkitRelativePath || highlightedFile.name) === relativePath)
            ? "highlight-file-input" 
            : ""
        }`}
        onClick={() => {
          if (isChanged) {
            setSelectedDiff({
              fileName,
              original: originalFiles[relativePath] || "",
              changed: changedFiles[fileName]
            });
          } else {
            handleFileClick(dir.file);
          }
        }}
      >
      📄 {fileName}
    </div>
    );
  } else {
    // It's a top-level directory container
    return (
      <div className="directory-container">
        <div
          className="directory-name"
          onClick={() => toggleDirectory(dir.name, directories)}
        >
          {dir.expanded ? '📂' : '📁'} {dir.name}
        </div>
        {dir.expanded && (
          <div className="directory-contents">
            {Object.keys(dir.files).map(key => (
              <div key={`${dir.name}/${key}`} className="file-item">
                {renderDirectory(dir.files[key], `${dir.name}/${key}`)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
};

const traverseFileTree = (node, path = "") => {
  const filesArr = [];
  // If the node is explicitly a file, add it.
  if (node.__isFile) {
    filesArr.push({ file: node.file, path });
  }
  // If it's explicitly a directory, traverse its keys.
  else if (node.__isDirectory) {
    Object.keys(node).forEach(key => {
      if (key !== "__isDirectory" && key !== "__expanded") {
        filesArr.push(...traverseFileTree(node[key], path ? `${path}/${key}` : key));
      }
    });
  }
  // If there is no flag, assume it's an object container.
  else if (typeof node === "object" && node !== null) {
    Object.keys(node).forEach(key => {
      filesArr.push(...traverseFileTree(node[key], path ? `${path}/${key}` : key));
    });
  }
  return filesArr;
};

async function fetchLocalJSON(relativePath) {
  const response = await fetch(relativePath);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to fetch ${relativePath}: ${text}`);
  }
  return JSON.parse(text);
}

// Function to generate changed files using the backend endpoint
const handleGenerateChangedFiles = async () => {

  setChangedFilesProgress(0);

  let docstringsData = {};
  let topRData = {};
  try {
    [docstringsData, topRData] = await Promise.all([
      fetchLocalJSON('/docstrings.json'),
      fetchLocalJSON('/topR.json')
    ]);
  } catch (error) {
    console.error("Error fetching docstrings or topR:", error);
    return;
  }

  const allFiles = [];
  directories.forEach(dir => {
    const filesArr = traverseFileTree(dir.files, dir.name);
    allFiles.push(...filesArr);
  });

  const filesData = {};
  for (const { file } of allFiles) {
    // Use full relative path as key.
    const relativePath = file.webkitRelativePath || file.name;
    const content = await file.text();
    filesData[relativePath] = content;
  }

  setOriginalFiles(filesData);

  const payload = { files: filesData, topR: topRData, docstrings: docstringsData, low_level_plan: llmResponse };

  const interval = setInterval(() => {
    setChangedFilesProgress(prev => (prev >= 90 ? prev : prev + 10));
  }, 500);
  
  try {
    const response = await fetch(`${API_URL}/generate_changed_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    console.log("Changed files from API:", result.changed_files);
    setChangedFiles(result.changed_files);
    // Now, for each file returned in changed_files, extract the python code and update originalFiles state.
    const updatedFiles = { ...filesData };
    for (const filePath in result.changed_files) {
      const updatedCode = extractCode(result.changed_files[filePath]);
      updatedFiles[filePath] = updatedCode;
    }
    //console.log("API result:", result);
    setOriginalFiles(updatedFiles);
    console.log("Updated originalFiles:", updatedFiles);
  } catch (error) {
    console.error("Error generating changed files:", error);
  } finally {
    clearInterval(interval);
    setChangedFilesProgress(100);
  }
};

  const dummyTopR = {
    "snake.py": "Dummy plan: refactor code structure and add error handling.",
    "game.py": "Dummy plan: optimize loops and remove deprecated functions.",
    "main.py": "Dummy plan: optimize loops and remove deprecated functions."
  }


  function extractCode(text) {
    const regex = /```python\s*\n([\s\S]*?)```/gi;
    let lastMatch = "";
    let match;
    while ((match = regex.exec(text)) !== null) {
      lastMatch = match[1].trim();
    }
    return lastMatch || text.trim();
  }

  return (
    <div className="app-container">
      <div className="pane feature-pane">
        <h2>Feature Description</h2>
  
        {/* Textarea with default text that can't be removed */}
        <div className="upload-section">
          <textarea
            className="feature-textarea"
            value={featureInput}
            onChange={handleFeatureInputChange}
          />
        </div>
  
        {/* Select a .txt file (preview it separately) */}
        <div className="upload-section">
          <input
            type="file"
            id="feature-file"
            accept=".txt"
            onChange={handleFeatureUpload}
            className="file-input"
          />
          <label htmlFor="feature-file" className="upload-button">
            Select .txt File ⬆
          </label>
          
          {featureFile && (
            <button 
              onClick={analyzeFeature} 
              className="analyze-button"
              disabled={isLoading}
            >
              {isLoading ? 'Analyzing...' : 'Analyze with LLM'}
            </button>
          )}
        </div>
  
        {/* Show the .txt file preview (not merged yet) */}
        {filePreview && (
          <div className="file-preview-box">
            <div>
            <h3>Uploaded File Preview</h3>
            </div>
            <div>
            <div className="file-preview-content">
              <pre>{filePreview}</pre>
            </div>
            </div>
          </div>
        )}
  
        {/* Single button merges typed text + file content */}
        <div>
        <button onClick={handleFeatureUpload} className="upload-button arrow-up">
          Upload ⬆
        </button>
        </div>

        {/* {isLoading && ( */}
          <div className="analysis-progress">
            <div className="progress-bar">
              <div className="progress" style={{ width: `${analysisProgress}%` }}></div>
            </div>
          </div>
        {/* )} */}

        {/* <div>
        <button onClick={runCode} className="upload-button">
          Run the Code
        </button>
        </div> */}
        {runOutput && (
          <div className="run-output">
            <h3>Execution Output</h3>
            <pre>{runOutput}</pre>
          </div>
        )}
  
        {/* Final merged featureContent as Markdown */}
        {featureContent && (
          <div className="feature-content">
            <h3>Final Feature Description</h3>
            <div className="content-preview">
              <ReactMarkdown>{featureContent}</ReactMarkdown>
            </div>
          </div>
        )}
        
        {/* LLM Analysis Result */}
        {(llmResponse || isLoading || analysisError) && (
          <div className="llm-analysis">
            <h3>LLM Analysis</h3>
            {isLoading && (
              <div className="loading-spinner">
                Analyzing feature description...
              </div>
            )}
            
            {analysisError && (
              <div className="error-message">
                {analysisError}
              </div>
            )}
            
            {llmResponse && !isLoading && !analysisError && (
              <div className="analysis-result">
                <SyntaxHighlighter
                  language="markdown"
                  style={oneLight}
                  wrapLines
                >
                  {llmResponse}
                </SyntaxHighlighter>
              </div>
            )}
          </div>
        )}
      </div>
        {/* RIGHT PANE: Code Directory & Viewer */}
      <div className="pane code-pane">
        <h2>Code Repository</h2>
        <div className="upload-section">
          <input
            type="file"
            id="directory-upload"
            onChange={handleDirectoryUpload}
            webkitdirectory=""
            directory=""
            multiple
            className="file-input"
          />
          <label htmlFor="directory-upload" className="upload-button arrow-up">
            Upload Directory ⬆
          </label>
        </div>
        {loading && (
          <div className="loading">
            Processing files...
            <div className="progress-bar">
              <div className="progress" style={{ width: `${progress}%` }}></div>
            </div>
          </div>
        )}
        <div className="directory-viewer">
          {directories.map((dir, index) => (
            <div key={index} className="directory-entry">
              {renderDirectory(dir)}
            </div>
          ))}
        </div>

        <div className="upload-section">
        {/* Button to trigger changed file generation */}
        <button onClick={handleGenerateChangedFiles} className="upload-button">
          Generate Changed Files
        </button>

        {/* Conditionally render the "Run main.py" button if main.py is found */}
        {mainFileItem && (
          <button
            onClick={() => runMainPy(mainFileItem)}
            className="upload-button"
          >
            Run main.py
          </button>
        )}
        </div>

        <div className="analysis-progress">
          <div className="progress-bar">
            <div className="progress" style={{ width: `${changedFilesProgress}%` }}></div>
          </div>
        </div>
      </div>
  
      {/* MODAL for code file preview */}
      {showFilePreview && (
        <div className="file-preview-modal">
          <div className="file-preview-content">
            <div className="file-preview-header">
              <h3>{selectedFile?.name}</h3>
              <button onClick={closeFilePreview} className="close-button">×</button>
            </div>
            <div className="file-preview-body">
              {language ? (
                <SyntaxHighlighter
                  language={language}
                  style={oneLight}
                  wrapLines
                  showLineNumbers
                >
                  {fileContent}
                </SyntaxHighlighter>
              ) : (
                <pre>{fileContent}</pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL for diff view of changed files */}
      {selectedDiff && (
        <div className="file-diff-modal">
          <div className="file-diff-content">
            <div className="file-diff-header">
              <h3>{selectedDiff.fileName} - Diff View</h3>
              <button onClick={() => setSelectedDiff(null)} className="close-button">×</button>
            </div>
            <div className="file-diff-body">
              <ReactDiffViewer
                oldValue={selectedDiff.original}
                newValue={extractCode(selectedDiff.changed)}
                splitView={true}
              />
            </div>
          </div>
        </div>
      )}

    </div>
  )};