from flask import Flask, request, jsonify
from flask_cors import CORS
import uuid

app = Flask(__name__)
CORS(app)

# Mock DB
todos = []

# CreateTodo
@app.route('/api/v1/createTodo', methods=['POST'])
def create_todo():
    data = request.json
    todo = {
        "id": str(uuid.uuid4()),
        "title": data.get("title"),
        "completed": False
    }
    todos.append(todo)
    return jsonify({
        "success": True,
        "id": todo["id"]
    })

# SearchTodos
@app.route('/api/v1/todoList', methods=['GET'])
def search_todos():
    searchKey = request.args.get('searchKey', '')
    page = int(request.args.get('page', 1))
    pageSize = int(request.args.get('pageSize', 10))

    filtered = [
        t for t in todos
        if not t["completed"] and (searchKey in t["title"])
    ]

    start = (page - 1) * pageSize
    end = start + pageSize

    return jsonify({
        "data": filtered[start:end],
        "total": len(filtered)
    })

# CompleteTodo
@app.route('/api/v1/completeTodo', methods=['POST'])
def complete_todo():
    data = request.json
    id = data.get("id")

    for t in todos:
        if t["id"] == id:
            t["completed"] = True
            return jsonify({"success": True})

    return jsonify({"success": False})

if __name__ == '__main__':
    app.run(debug=True)