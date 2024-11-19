"""
Interactive JSON Visualizer
--------------------------
A Streamlit application that creates interactive visualizations of JSON data structures.
Similar to JSON Crack, it provides an intuitive way to explore and understand complex JSON structures
through an interactive node-graph interface.

Author: Srinjoy Ghosh
Version: 1.0.0
Date: 2024
"""

import streamlit as st
import streamlit.components.v1 as components
import json
import uuid
import pandas as pd
from pyvis.network import Network
import tempfile
import os
import time

def create_node_id():
    """
    Generate a unique identifier for each node in the visualization.
    
    Returns:
        str: A unique 8-character identifier
    """
    return str(uuid.uuid4())[:8]

def get_node_color(data_type):
    """
    Determine the color for a node based on its data type.
    
    Args:
        data_type (str): The type of data ('dict', 'list', 'str', 'num', 'bool', 'null')
    
    Returns:
        str: Hexadecimal color code
    """
    colors = {
        'dict': '#2B6CB0',    # Blue for objects
        'list': '#4C51BF',    # Indigo for arrays
        'str': '#48BB78',     # Green for strings
        'num': '#ED8936',     # Orange for numbers
        'bool': '#9F7AEA',    # Purple for booleans
        'null': '#718096'     # Gray for null
    }
    return colors.get(data_type, '#718096')

def get_data_type(value):
    """
    Determine the data type of a value.
    
    Args:
        value: Any JSON-compatible value
    
    Returns:
        str: String representation of the data type
    """
    if isinstance(value, dict):
        return 'dict'
    elif isinstance(value, list):
        return 'list'
    elif isinstance(value, str):
        return 'str'
    elif isinstance(value, (int, float)):
        return 'num'
    elif isinstance(value, bool):
        return 'bool'
    elif value is None:
        return 'null'
    return 'unknown'

def process_json_interactive(data, net, parent_id=None, key=None):
    """
    Recursively process JSON data and create an interactive network visualization.
    
    Args:
        data: JSON data to process
        net: Pyvis Network object
        parent_id (str, optional): ID of the parent node
        key (str, optional): Key or index of the current node
    
    Returns:
        str: ID of the current node
    """
    current_id = create_node_id()
    data_type = get_data_type(data)
    
    # Create label based on data type
    if isinstance(data, (dict, list)):
        label = f"{key if key else ''}\n{'{}' if isinstance(data, dict) else '[]'}"
    else:
        label = f"{key if key else ''}\n{str(data)}"
    
    # Add node with styling
    net.add_node(
        current_id,
        label=label,
        color=get_node_color(data_type),
        shape='box' if isinstance(data, (dict, list)) else 'box',
        font={'color': 'white'},
        borderWidth=2,
        shadow=True
    )
    
    # Connect to parent if exists
    if parent_id:
        net.add_edge(parent_id, current_id, color='#718096')
    
    # Process children recursively
    if isinstance(data, dict):
        for k, v in data.items():
            process_json_interactive(v, net, current_id, k)
    elif isinstance(data, list):
        for i, item in enumerate(data):
            process_json_interactive(item, net, current_id, f"[{i}]")
    
    return current_id

def load_json_file(file):
    """
    Load and parse various file formats into JSON data.
    
    Args:
        file: Uploaded file object
    
    Returns:
        dict: Parsed JSON data
    
    Raises:
        Exception: If file reading or parsing fails
    """
    try:
        if file.name.endswith('.json'):
            content = file.read().decode('utf-8')
            return json.loads(content)
        elif file.name.endswith('.csv'):
            df = pd.read_csv(file)
            return json.loads(df.to_json(orient='records'))
        elif file.name.endswith('.xlsx'):
            df = pd.read_excel(file)
            return json.loads(df.to_json(orient='records'))
        else:
            raise ValueError("Unsupported file type. Please upload a .json, .csv, or .xlsx file.")
    except Exception as e:
        raise Exception(f"Error reading file: {str(e)}")

@st.cache_data
def create_interactive_visualization(json_data):
    """
    Create an interactive visualization of JSON data.
    
    Args:
        json_data: JSON data to visualize
    
    Returns:
        str: HTML content of the visualization
    """
    # Initialize network
    net = Network(height='600px', width='100%', bgcolor='#1A202C', font_color='white')
    net.force_atlas_2based()
    process_json_interactive(json_data, net)
    
    # Create unique filename
    filename = f"graph_{int(time.time())}_{uuid.uuid4().hex[:8]}.html"
    filepath = os.path.join(tempfile.gettempdir(), filename)
    
    try:
        net.save_graph(filepath)
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        return content
    finally:
        # Clean up temporary file
        try:
            if os.path.exists(filepath):
                os.remove(filepath)
        except:
            pass

def main():
    """
    Main application function that sets up the Streamlit interface and handles user interaction.
    """
    # Page configuration
    st.set_page_config(layout="wide")
    
    st.title("Interactive JSON Visualizer")
    
    # Apply dark theme
    st.markdown("""
        <style>
        .stApp {
            background-color: #1A202C;
            color: white;
        }
        </style>
    """, unsafe_allow_html=True)
    
    # Create input tabs
    tab1, tab2 = st.tabs(["Text Input", "File Upload"])
    
    json_data = None
    
    # Text input tab
    with tab1:
        st.write("Paste your JSON data below to visualize it as an interactive graph")
        json_input = st.text_area("JSON Input", height=200)
        if json_input:
            try:
                json_data = json.loads(json_input)
            except json.JSONDecodeError:
                st.error("Invalid JSON input. Please check your JSON syntax.")
    
    # File upload tab
    with tab2:
        st.write("Upload a file to visualize (.json, .csv, or .xlsx)")
        uploaded_file = st.file_uploader("Choose a file", type=['json', 'csv', 'xlsx'])
        if uploaded_file:
            try:
                json_data = load_json_file(uploaded_file)
                st.text_area("Loaded JSON", value=json.dumps(json_data, indent=2), height=200)
            except Exception as e:
                st.error(f"Error: {str(e)}")
    
    # Process and display visualization
    if json_data:
        try:
            html_content = create_interactive_visualization(json_data)
            components.html(html_content, height=600)
            
            # Add download button
            st.download_button(
                label="Download JSON",
                data=json.dumps(json_data, indent=2),
                file_name="data.json",
                mime="application/json"
            )
            
        except Exception as e:
            st.error(f"An error occurred while creating the visualization: {str(e)}")
    
    # Sidebar with example
    st.sidebar.header("Example JSON")
    example_json = {
        "name": "John Doe",
        "age": 30,
        "address": {
            "street": "123 Main St",
            "city": "New York"
        },
        "hobbies": ["reading", "gaming", "coding"]
    }
    st.sidebar.code(json.dumps(example_json, indent=2))
    if st.sidebar.button("Load Example"):
        st.text_area("JSON Input", value=json.dumps(example_json, indent=2))

if __name__ == "__main__":
    main()
