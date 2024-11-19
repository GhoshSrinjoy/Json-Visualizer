## Overview
The Interactive JSON Visualizer is a powerful web-based tool that transforms complex JSON data structures into interactive, visual node graphs. Built with Streamlit and Pyvis, it provides an intuitive way to explore and understand JSON data through a dynamic, user-friendly interface.

## Features
- **Interactive Visualization**: Drag-and-drop nodes, zoom, and pan functionality
- **Multiple Input Methods**: 
  - Direct JSON text input
  - File upload support (.json, .csv, .xlsx)
- **Visual Enhancement**:
  - Color-coded nodes based on data types
  - Clear hierarchical structure
  - Dark theme for better visibility
- **User-Friendly Interface**:
  - Split-panel layout
  - Example JSON for quick testing
  - Download functionality
  - Error handling and validation

## Installation

### Prerequisites
- Python 3.7 or higher
- pip package manager

### Setup
1. Clone the repository:
```bash
git clone [repository-url]
cd json-visualizer
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
