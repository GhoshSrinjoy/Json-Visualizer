*“Ever tried scrolling through nested JSON? It’s like opening Russian dolls that throw key errors.”*  

# 🧠 Interactive JSON Visualizer  

A web-based app that turns tangled JSON data into a beautiful, interactive network graph.  
Built with **Streamlit** and **Pyvis**, it helps you actually *see* your data , not just scroll through brackets.  

🔗 **Repo:** https://github.com/GhoshSrinjoy/Json-Visualizer  

---

## Executive Summary  

The Interactive JSON Visualizer is designed for developers, analysts, and anyone who’s ever thought,  
“Wait, where does this key even live?”  

It reads your JSON, builds a hierarchical graph, and lets you explore the structure visually , complete with color-coded nodes, drag interactions, and file upload support.  

---

## Features  

✅ **Interactive Visualization** – Drag, zoom, and pan across nodes to explore structure.  
📂 **Multiple Input Options** – Paste raw JSON or upload `.json`, `.csv`, or `.xlsx` files.  
🎨 **Smart Visual Design** – Color-coded nodes by data type, dark theme, and clear hierarchies.  
💡 **Ease of Use** – Example JSON, split-panel layout, instant updates, and error validation.  
⬇️ **Export-Ready** – Download processed JSON anytime.  

---

## Methodology  

### 1️⃣ Input Handling  
- Users can paste JSON text directly or upload a file.  
- The system parses and validates the data automatically.  

### 2️⃣ Graph Generation  
- Using **NetworkX** + **Pyvis**, each key-value pair is mapped into a **node-edge graph**.  
- Parent-child relationships are visually linked for better structure understanding.  

### 3️⃣ Rendering & Interaction  
- The graph is rendered in a **Streamlit** interface.  
- Nodes are draggable, zoomable, and highlight on hover for detail view.  

---

## Color Coding  

| Data Type | Color |
|------------|--------|
| Object (dict) | 🔵 Blue |
| Array (list) | 🟣 Indigo |
| String | 🟢 Green |
| Number | 🟠 Orange |
| Boolean | 🟪 Purple |
| Null | ⚪ Gray |

## Installation

### Prerequisites
- Python 3.7 or higher
- pip package manager

### Setup
1. Clone the repository:
```bash
git clone https://github.com/GhoshSrinjoy/Json-Visualizer.git
cd Json-Visualizer
```

2. Install required packages:
```bash
pip install -r requirements.txt
```

Or install packages individually:
```bash
pip install streamlit pandas pyvis networkx openpyxl
```

### Running the Application
```bash
streamlit run app.py
```

## Usage

### Text Input
1. Navigate to the "Text Input" tab
2. Paste your JSON data into the text area
3. The visualization will automatically update

### File Upload
1. Navigate to the "File Upload" tab
2. Upload a supported file (.json, .csv, .xlsx)
3. Preview the loaded data and visualization

### Interacting with the Visualization
- **Drag nodes**: Click and drag to reposition
- **Zoom**: Use mouse wheel or touchpad
- **Pan**: Click and drag the background
- **View details**: Hover over nodes
- **Download**: Use the download button to save processed JSON

## Color Coding
- Blue: Objects (dictionaries)
- Indigo: Arrays (lists)
- Green: Strings
- Orange: Numbers
- Purple: Booleans
- Gray: Null values

## Contributing
Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments
- Inspired by JSON Crack
- Built with Streamlit and Pyvis
