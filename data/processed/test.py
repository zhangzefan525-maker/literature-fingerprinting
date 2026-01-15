import json
import matplotlib.pyplot as plt

# Load JSON data
with open('The Adventures of Tom Sawyer.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# Extract sentence length data
blocks = [item['block'] for item in data['sentenceLength']]
values = [item['value'] for item in data['sentenceLength']]

# Create bar chart
plt.figure(figsize=(15, 6))
plt.bar(blocks, values, color='skyblue', edgecolor='black')

# Add labels and title
plt.xlabel('Block Number')
plt.ylabel('Average Sentence Length')
plt.title('Average Sentence Length per Block in "The Adventures of Tom Sawyer"')
plt.grid(axis='y', linestyle='--', alpha=0.7)

# Show plot
plt.tight_layout()
plt.show()